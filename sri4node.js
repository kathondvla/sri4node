/*
  The core server for the REST api.
  It is configurable, and provides a simple framework for creating REST interfaces.
*/
var validator = require('jsonschema').Validator;
var Q = require("q");

var configuration;
var resources;
var logsql;
var pg;

// Q wrapper to get a node-postgres client from the client pool.
// It returns a Q promise to allow chaining, error handling, etc.. in Q-style.
var pgConnect = function () {
    var deferred = Q.defer();

    // ssl=true is required for heruko.com
    // ssl=false is required for development on local postgres (Cloud9)
    var dbUrl;
    if(process.env.DATABASE_URL) {
        dbUrl = process.env.DATABASE_URL + "?ssl=true";
    } else {
        dbUrl = configuration.defaultdatabaseurl;
    }
    //cl("Using database connection string : [" + dbUrl + "]");
    
    pg.connect(dbUrl, function (err, client, done) {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve({
                client: client,
                done: done
            });
        }
    });

    return deferred.promise;
};

// Q wrapper for executing SQL statement on a node-postgres client.
//
// Instead the db object is a node-postgres Query config object.
// See : https://github.com/brianc/node-postgres/wiki/Client#method-query-prepared.
//
// name : the name for caching as prepared statement, if desired.
// text : The SQL statement, use $1,$2, etc.. for adding parameters.
// values : An array of java values to be inserted in $1,$2, etc..
//
// It returns a Q promise to allow chaining, error handling, etc.. in Q-style.
var parameterPattern = '$?$?';
var pgExec = function (db, query) {
    var deferred = Q.defer();
    var q = {};
    
    q.text = query.text;
    q.values = query.params;
    var paramCount = 1;
    if(q.values && q.values.length > 0) {
        for(var i=0; i<q.values.length; i++) {
            var index = q.text.indexOf(parameterPattern);
            if(index == -1) {
                var msg = "Parameter count in query does not add up. Too few parameters in the query string";
                debug("** " + msg); 
                deferred.reject(msg);
            } else {
                var prefix = q.text.substring(0,index);
                var postfix = q.text.substring(index+parameterPattern.length,q.text.length);
                q.text = prefix + "$" + paramCount + postfix;
                paramCount++;
            }
        }
        var index = q.text.indexOf(parameterPattern);
        if(index != -1) {
            var msg = "Parameter count in query does not add up. Extra parameters in the query string.";
            debug("** " + msg);
            deferred.reject();
        }
    }

    if (logsql) {
        cl(q);
    }

    db.client.query(q, function (err, result) {
        if (err) {
            if (logsql) {
                cl("SQL error :");
                cl(err);
            }
            deferred.reject(err);
        } else {
            if (logsql) {
                cl("SQL result : ");
                cl(result.rows);
            }
            deferred.resolve(result);
        }
    });

    return deferred.promise;
};

// Creates a config object for q node-postgres prepared statement.
// It also adds some convenience functions for handling appending of SQL and parameters.
var prepare = function(name) {
    return {
        name: name,
        text: '',
        params: [],
        param: function(x) {
            // Convenience function for adding a parameter to the text, it
            // automatically adds $x to the SQL text, and adds the supplied value
            // to the 'value'-array.
            var index = this.params.length + 1;
            this.params.push(x);
            this.text = this.text + parameterPattern;

            return this;
        },
        sql: function(x) {
            // Convenience function for adding a parameter to the SQL statement.
            this.text = this.text + x;

            return this;
        },
        array: function(x) {
            // Convenience function for adding an array of values to a SQL statement.
            // The values are added comma-separated.

            if(x && x.length && x.length > 0) {
                for(var i=0; i< x.length; i++) {
                    this.param(x[i]);
                    if (i < (x.length - 1)) {
                        this.text = this.text + ',';
                    }
                }
            }

            return this;
        },
        keys: function(o) {
            // Convenience function for adding all keys in an object (comma-separated)
            var columnNames = [];

            for (var key in o) {
                if (o.hasOwnProperty(key)) {
                    columnNames.push(key);
                }
            }
            var sqlColumnNames = '';
            for (var j = 0; j < columnNames.length; j++) {
                sqlColumnNames += columnNames[j];
                if (j < columnNames.length - 1) {
                    sqlColumnNames += ",";
                }
            }
            this.text = this.text + sqlColumnNames;

            return this;
        },
        values: function(o) {
            // Convenience function for adding all values of an object as parameters.
            // Same iteration order as 'columns'.
            var firstcolumn = true;
            for (var key in o) {
                if (o.hasOwnProperty(key)) {
                    if(!firstcolumn) {
                        this.text += ",";
                    } else {
                        firstcolumn = false;
                    }
                    this.param(o[key]);
                }
            }

            return this;
        },
        with: function(query, virtualtablename) {
            if(this.text.indexOf('WITH') == -1) {
                this.text = 'WITH ' + virtualtablename + ' AS (' + query.text + ') /*LASTCTE*/ ' + this.text;
            } else {
                var cte = ', ' + virtualtablename + ' AS (' + query.text + ') /*LASTCTE*/ ';
                this.text = this.text.replace('/*LASTCTE*/',cte);
            }
            this.params = query.params.concat(this.params);
            
            return this;
        }
    }
};

// Converts the configuration object for roa4node into an array per resource type.
var typeToConfig = function(config) {
    var ret = {};
    for (var i = 0; i < config.length; i++) {
        ret[config[i].type] = config[i];
    }
    return ret;
};

// Create a ROA resource, based on a row result from node-postgres.
function mapColumnsToObject(config, mapping, row, element) {
    var typeToMapping = typeToConfig(config);

    // add all mapped columns to output.
    for (var key in mapping.map) {
        if (mapping.map.hasOwnProperty(key)) {
            if (mapping.map[key].references) {
                var referencedType = mapping.map[key].references;
                element[key] = {href: typeToMapping[referencedType].type + '/' + row[key]};
            } else if (mapping.map[key].onlyinput) {
                // Skip on output !
            } else {
                element[key] = row[key];
            }
        }
    }
}

function sqlColumnNames(mapping) {
    var columnNames = [];

    for (var key in mapping.map) {
        if (mapping.map.hasOwnProperty(key)) {
            columnNames.push(key);
        }
    }
    var sqlColumnNames = '"guid",';
    for (var j = 0; j < columnNames.length; j++) {
        sqlColumnNames += '"' + columnNames[j] + '"';
        if (j < columnNames.length - 1) {
            sqlColumnNames += ",";
        }
    }

    return sqlColumnNames;
}

// apply extra parameters on request URL for a list-resource to a sselect.
function applyRequestParameters(mapping, req, select, database, count) {
    var deferred = Q.defer();
    
    var urlparameters = req.query;
    var standard_parameters = ['orderby', 'descending', 'limit', 'offset','expand','hrefs'];

    var promises = [];
    var reject = false;
    if (mapping.query) {
        for (var key in urlparameters) {
            if (urlparameters.hasOwnProperty(key)) {
                if (standard_parameters.indexOf(key) == -1) {
                    if (mapping.query[key]) {
                        // Execute the configured function that will apply this URL parameter
                        // to the SELECT statement
                        promises.push(mapping.query[key](urlparameters[key], select, key, database, count));
                    } else {
                        debug("rejecting unknown query parameter : [" + key + "]");
                        reject = true;
                        deferred.reject({
                            type: 'unknown.query.parameter',
                            status: 404,
                            body: {
                                errors: [
                                    { 
                                        code: 'invalid.query.parameter',
                                        parameter: key
                                    }
                                ]
                            }
                        });
                        break;
                    }
                } else if(key == 'hrefs') {
                    promises.push(exports.queryUtils.filterHrefs(urlparameters['hrefs'], select, key, database, count));
                }
            }
        }
    }
    
    if(!reject) {
        Q.allSettled(promises).then(function(results) {
            var errors = [];
            results.forEach(function(result) {
                if(result.state == 'rejected') {
                    errors.push(result.reason);
                }
            });

            if(errors.length == 0) {
                deferred.resolve();
            } else {
                var ret = { 
                    // When rejecting we return an object with :
                    // 'type' -> an internal code to identify the error. Useful in the fail() method.
                    // 'status' -> the returned HTTP status code.
                    // 'body' -> the response body that will be returned to the client.
                    type: 'query.functions.rejected',
                    status: 404,
                    body: {
                        errors: errors 
                    }
                };
                deferred.reject(ret);
            }
        });
    }
    
    return deferred.promise;
}

// Execute registered mapping functions for elements of a ROA resource.
function executeOnFunctions(config, mapping, ontype, element) {
    for (var key in mapping.map) {
        if (mapping.map.hasOwnProperty(key)) {
            if (mapping.map[key][ontype]) {
                mapping.map[key][ontype](key, element);
            }
        }
    }
}

function queryByGuid(config, db, mapping, guid) {
    debug('** queryByGuid()');
    var columns = sqlColumnNames(mapping);
    var table = mapping.type.split("/")[1];

    var query = prepare('select-row-by-guid-from-' + table);
    query.sql('select ' + columns + ' from "' + table + '" where "guid" = ').param(guid);
    return pgExec(db, query).then(function (result) {
        var deferred = Q.defer();
        
        var rows = result.rows;
        if(rows.length == 1) {
            var row = result.rows[0];
            
            var output = {};
            debug('** mapping columns to JSON object');
            mapColumnsToObject(config, mapping, row, output);
            debug('** executing onread functions');
            executeOnFunctions(config, mapping, "onread", output);
            debug('** result of queryByGuid() : ');
            debug(output);
            deferred.resolve(output);
        } else if (rows.length == 0) {
            deferred.reject({
                type: "not.found",
                status: 404,
                body: "Not Found"
            });
        } else {
            var msg = "More than one entry with guid " + guid + " found for " + mapping.type;
            debug(msg);
            deferred.reject(new Error(msg));
        }    
        return deferred.promise;
    });
}

function getSchemaValidationErrors(json, schema) {
    var asCode = function (s) {
        // return any string as code for REST API error object.
        var ret = s;

        ret = ret.toLowerCase().trim();
        ret = ret.replace(/[^a-z0-9 ]/gmi, "");
        ret = ret.replace(/ /gmi, ".");

        return ret;
    };

    var v = new validator();
    var result = v.validate(json, schema);

    if (result.errors && result.errors.length > 0) {
        cl("Schema validation revealed errors.");
        cl(result.errors);
        cl("JSON schema was : ");
        cl(schema);
        cl("Document was : ");
        cl(json);
        var ret = {};
        ret.errors = [];
        ret.document = json;
        for (var i = 0; i < result.errors.length; i++) {
            var current = result.errors[i];
            var err = {};
            err.code = asCode(current.message);
            if(current.property && current.property.indexOf("instance.") == 0) {
                err.path = current.property.substring(9);
            }
            ret.errors.push(err);
        }
        return ret;
    }
}

function send500(resp) {
    return function (error) {
        cl("Error. Sending status 500.");
        cl(error);
        resp.status(500).send("Internal Server Error. [" + error.toString() + "]");
    };
}

function endResponse(resp) {
    return function () {
        resp.end();
    };
}

function cl(x) {
    console.log(x);
}

function debug(x) {
    if(configuration.logdebug) console.log(x);
}

// Security cache; stores a map 'e-mail' -> 'password'
// To avoid a database query for all API calls.
var knownPasswords = {};

// Force https in production.
function forceSecureSockets(req, res, next) {
    var isHttps = req.headers['x-forwarded-proto'] == 'https';
    if (!isHttps && req.get('Host').indexOf('localhost') < 0 && req.get('Host').indexOf('127.0.0.1') < 0) {
        return res.redirect('https://' + req.get('Host') + req.url);
    }

    next();
}

function checkBasicAuthentication(req, res, next) {
    var path = req.route.path;
    if(path !== '/me' && path != '/batch') {
        var typeToMapping = typeToConfig(resources);
        var type = '/' + req.route.path.split("/")[1];
        var mapping = typeToMapping[type];
        if(mapping.public) {
            next();
            return;
        }
    }
    
    var unauthorized = function () {
        res.setHeader('WWW-Authenticate', 'Basic realm="Secure Area"');
        res.status(401).send("Unauthorized");
    };

    if (req.headers.authorization) {
        var basic = req.headers.authorization;
        var encoded = basic.substr(6);
        var decoded = new Buffer(encoded, 'base64').toString('utf-8');
        var firstColonIndex = decoded.indexOf(':');
        if (firstColonIndex != -1) {    
            var email = decoded.substr(0, firstColonIndex);
            var password = decoded.substr(firstColonIndex + 1);
            if (email && password && email.length > 0 && password.length > 0) {
                if (knownPasswords[email]) {
                    if (knownPasswords[email] === password) {
                        next();
                    } else {
                        debug("Invalid password");
                        unauthorized();
                    }
                } else {
                    var database;
                    pgConnect().then(function (db) {
                        database = db;

                        var q = prepare("select-count-from-persons-where-email-and-password");
                        q.sql('select count(*) from persons where email = ').param(email).sql(' and password = ').param(password);

                        return pgExec(db, q).then(function (result) {
                            var count = parseInt(result.rows[0].count);
                            if (count == 1) {
                                // Found matching record, add to cache for subsequent requests.
                                knownPasswords[email] = password;
                                next();
                            } else {
                                debug("Wrong combination of email / password. Found " + count + " records.");
                                unauthorized();
                            }
                        });
                    }).then(function () {
                        database.done();
                    }).fail(function (err) {
                        debug("checking basic authentication against database failed.");
                        debug(err);
                        debug(err.stack);
                        database.done(err);
                        unauthorized();
                    });
                }
            } else unauthorized();
        } else unauthorized();
    } else {
        debug("No authorization header received from client. Rejecting.");
        unauthorized();
    }
}

// Apply CORS headers.
// TODO : Change temporary URL into final deploy URL.
var allowCrossDomain = function(req, res, next) {
    res.header('Access-Control-Allow-Origin', 'https://sheltered-lowlands-3555.herokuapp.com');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    next();
};

function logRequests(req, res, next) {
    if(configuration.logrequests) {
        cl(req.method + " " + req.path + " starting.");
        var start = Date.now();
        res.on('finish', function () {
            var duration = Date.now() - start;
            cl(req.method + " " + req.path + " took " + duration + " ms. ");
        });
    }
    next();
}

function executeValidateMethods(mapping, body, db) {
    var deferred = Q.defer();

    if(mapping.validate && mapping.validate.length > 0) {
        debug("Executing validation methods.");
        var promises = [];
        mapping.validate.forEach(function(f) {
            promises.push(f(body, db));
        });
        
        Q.allSettled(promises).then(function(results) {
            var errors = [];
            results.forEach(function(result) {
                if(result.state == 'rejected') {
                    errors.push(result.reason);
                }
            });
            
            if(errors.length == 0) {
                deferred.resolve();
            } else {
                var ret = { errors: errors };
                debug("Some validate methods rejected : ");
                debug(ret);
                deferred.reject(ret);
            }
        });
    } else {
        debug("No validate methods were registered.");
        deferred.resolve();
    }

    return deferred.promise;
}

function postProcess(functions, db, body) {
    var deferred = Q.defer();

    if(functions && functions.length > 0) {
        var promises = [];
        functions.forEach(function(f) {
            promises.push(f(db, body));
        });
    
        Q.all(promises).then(function(results) {
            debug('all post processing functions resolved.');
            deferred.resolve();
        }).catch(function(error) {
            debug('one of the post processing functions rejected.');
            deferred.reject();
        });
    } else {
        debug("no post processing functions registered.");
        deferred.resolve();
    }
    
    return deferred.promise;
}

function executePutInsideTransaction(db, url, body) {
    var type = '/' + url.split("/")[1];
    var guid = url.split("/")[2];
    
    debug('PUT processing starting. Request body :');
    debug(body);
    
    var typeToMapping = typeToConfig(resources);
    // var type = '/' + req.route.path.split("/")[1];
    var mapping = typeToMapping[type];
    var table = mapping.type.split("/")[1];

    debug("Validating schema.");
    if (mapping.schema) {
        var errors = getSchemaValidationErrors(body, mapping.schema);
        if (errors) {
            var deferred = Q.defer();
            deferred.reject(errors);
            return deferred.promise;
        } else {
            debug("Schema validation passed.");
        }
    }
    
    return executeValidateMethods(mapping, body, db).then(function() {
        // create an object that only has mapped properties
        var element = {};
        for (var key in mapping.map) {
            if (mapping.map.hasOwnProperty(key)) {
                if(body[key]) {
                    element[key] = body[key];
                }
            }
        }
        debug("Mapped incomming object according to configuration");

        // check and remove types from references.
        for (var key in mapping.map) {
            if (mapping.map.hasOwnProperty(key)) {
                if (mapping.map[key].references) {
                    var value = element[key].href;
                    if(!value) {
                        throw new Error("No href found inside reference " + key);
                    }
                    var referencedType = mapping.map[key].references;
                    var referencedMapping = typeToMapping[referencedType];
                    var parts = value.split("/");
                    var type = '/' + parts[1];
                    var refguid = parts[2];
                    if (type === referencedMapping.type) {
                        element[key] = refguid;
                    } else {
                        cl("Faulty reference detected [" + element[key].href + "], detected [" + type + "] expected [" + referencedMapping.type + "]");
                        return;
                    }
                }
            }
        }
        debug('Converted references to values for update');

        var countquery = prepare('check-resource-exists-' + table);
        countquery.sql('select count(*) from ' + table + ' where "guid" = ').param(guid);
        return pgExec(db, countquery).then(function (results) {
            var deferred = Q.defer();

            if (results.rows[0].count == 1) {
                executeOnFunctions(resources, mapping, "onupdate", element);

                var update = prepare('update-' + table);
                update.sql('update "' + table + '" set ');
                var firstcolumn = true;
                for (var key in element) {
                    if (element.hasOwnProperty(key)) {
                        if(!firstcolumn) {
                            update.sql(',');
                        } else {
                            firstcolumn = false;
                        }

                        update.sql(key + '=').param(element[key]);
                    }
                }
                update.sql(" where guid = ").param(guid);

                return pgExec(db, update).then(function (results) {
                    if(results.rowCount != 1) {
                        debug("No row affected ?!");
                        var deferred = Q.defer();
                        deferred.reject("No row affected.");
                        return deferred.promise();
                    } else {
                        return postProcess(mapping.afterupdate, db, body);
                    }
                });
            } else {
                element.guid = guid;
                executeOnFunctions(resources, mapping, "oninsert", element);

                var insert = prepare("insert-"+ table);
                insert.sql('insert into "' + table + '" (').keys(element).sql(') values (').values(element).sql(') ');
                return pgExec(db, insert).then(function (results) {
                    if(results.rowCount != 1) {
                        debug("No row affected ?!");
                        var deferred = Q.defer();
                        deferred.reject("No row affected.");
                        return deferred.promise();
                    } else {
                        return postProcess(mapping.afterinsert, db, body);
                    }
                });
            }
        }); // pgExec(db,countquery)...
    }).fail(function(errors) {
        var deferred = Q.defer();
        deferred.reject(errors);
        return deferred.promise;
    });
}

// Local cache of known identities.
var knownIdentities = {};
// Returns a JSON object with the identity of the current user.
function getMe(req) {
    var deferred = Q.defer();
    
    var basic = req.headers.authorization;
    var encoded = basic.substr(6);
    var decoded = new Buffer(encoded, 'base64').toString('utf-8');
    var firstColonIndex = decoded.indexOf(':');
    if (firstColonIndex != -1) {
        var username = decoded.substr(0, firstColonIndex);
        if(knownIdentities[username]) {
            deferred.resolve(knownIdentities[username]);
        } else {
            var database;
            pgConnect().then(function (db) {
                database = db;
                return configuration.identity(username, db);
            }).then(function(me) {
                knownIdentities[username] = me;
                database.done();
                deferred.resolve(me);
            }).fail(function(err) {
                cl("Retrieving of identity had errors. Removing pg client from pool. Error : ")
                cl(err);
                database.done(err);
                deferred.reject(err);
            });
        }
    }
    
    return deferred.promise;
}

function validateAccessAllowed(mapping, db, req, resp, me) {
    var deferred = Q.defer();
    
    // Array of functions that returns promises. If any of the promises fail, 
    // the response will be 401 Forbidden. All promises must resolve (to empty values)
    var secure = mapping.secure;
    
    var promises = [];
    secure.forEach(function (f) {
        promises.push(f(req, resp, db, me));
    });
    
    if(secure.length > 0) {
        Q.all(promises).then(function(result) {
            deferred.resolve();
        }).catch(function(result) {
            deferred.reject({
                type: "access.denied",
                status: 403,
                body: "Forbidden"
            });
        });
    } else {
        deferred.resolve();
    }

    return deferred.promise;
}

function executeAfterReadFunctions(database, elements, mapping) {
    debug("executeAfterReadFunctions");
    var deferred = Q.defer();

    if(mapping.afterread && mapping.afterread.length > 0) {
        var promises = [];
        for(var i=0; i<mapping.afterread.length; i++) {
            promises.push(mapping.afterread[i](database,elements));
        }

        Q.allSettled(promises).then(function(results) {
            debug("allSettled :");
            debug(results);
            var errors = [];
            results.forEach(function(result) {
                if(result.state == 'rejected') {
                    errors.push(result.reason);
                }
            });

            if(errors.length == 0) {
                deferred.resolve();
            } else {
                var ret = { 
                    // When rejecting we return an object with :
                    // 'type' -> an internal code to identify the error. Useful in the fail() method.
                    // 'status' -> the returned HTTP status code.
                    // 'body' -> the response body that will be returned to the client.
                    type: 'afterread.failed',
                    status: 500,
                    body: {
                        errors: errors 
                    }
                };
                deferred.reject(ret);
            }
        });
    } else {
        // Nothing to do, resolve the promise.
        deferred.resolve();
    }
    
    return deferred.promise;    
}

// Expands a single path on an array of elements.
// Potential improvement : when the expansion would load obejcts that are already
// in the cluster currently loaded, re-use the loaded element, rather that querying it again.
function executeSingleExpansion(database, elements, mapping, resources, expandpath) {
    var deferred = Q.defer();
    
    try {
        if(elements && elements.length > 0) {        
            var query = prepare();
            var targetguids = [];
            var guidToElement = {};
            var firstDotIndex = expandpath.indexOf('.');
            var expand;
            var recurse;
            var recursepath;
            if(firstDotIndex == -1) {
                expand = expandpath;
                recurse = false;
            } else {
                expand = expandpath.substring(0,firstDotIndex);
                recurse = true;
                recursepath = expandpath.substring(firstDotIndex + 1, expandpath.length);
            }
            if(mapping.map[expand] == undefined) {
                debug('** rejecting expand value [' + expand + ']');
                deferred.reject();
            } else {            
                for(var i=0; i<elements.length; i++) {
                    var element = elements[i];
                    var permalink = element.$$meta.permalink;
                    var targetlink = element[expand].href;
                    var guid = permalink.split('/')[2];
                    var targetguid = targetlink.split('/')[2];
                    // Remove duplicates and items that are already expanded.
                    if(targetguids.indexOf(targetguid) == -1 && element[expand].$$expanded == undefined) {
                        targetguids.push(targetguid);
                    }
                    guidToElement[guid] = element;
                }

                var targetType = mapping.map[expand].references;
                var typeToMapping = typeToConfig(resources);
                var targetMapping = typeToMapping[targetType];
                var table = targetMapping.type.substr(1);
                var columns = sqlColumnNames(targetMapping);
                var targetpermalinkToObject = {};
                var expandedElements = [];
                
                debug(table);
                query.sql('select ' + columns + ' from "' + table + '" where guid in (').array(targetguids).sql(')');
                pgExec(database,query).then(function(result) {
                    debug('expansion query done');
                    var rows = result.rows;
                    for(var i=0; i<rows.length; i++) {
                        var row = rows[i];
                        var expanded = {};
                        var guid = row['guid'];
                        mapColumnsToObject(resources, targetMapping, row, expanded);
                        executeOnFunctions(resources, targetMapping, "onread", expanded);
                        targetpermalinkToObject[targetType + '/' + guid] = expanded;
                        expanded.$$meta = {permalink: mapping.type + '/' + guid};
                        expandedElements.push(expanded);
                    }
                    
                    debug('** executing afterread functions on expanded resources');
                    return executeAfterReadFunctions(database, expandedElements, targetMapping);
                }).then(function() {
                    for(var i=0; i<elements.length; i++) {
                        var element = elements[i];
                        var targetlink = element[expand].href;
                        element[expand].$$expanded = targetpermalinkToObject[targetlink];
                    }
                    if(recurse) {
                        debug('** recursing to next level of expansion : ' + recursepath);
                        executeSingleExpansion(database,expandedElements,targetMapping,resources,recursepath,guidToElement).then(function() {
                            deferred.resolve();
                        }).fail(function(e) {
                            deferred.reject(e);
                        });
                    } else {
                        debug('** executeSingleExpansion resolving');
                        deferred.resolve();
                    }
                });
            }
        } else {
            deferred.resolve();
        }
    } catch(e) {
        debug("** executeSingleExpansion failed : ");
        debug(e);
        deferred.reject(e.toString());
    }
    
    return deferred.promise;
}

/*
Reduce comma-separated expand parameter to array, in lower case, and remove 'results.href' as prefix.
The rest of the processing of expansion does not make a distinction between list resources and regular
resources. Also rewrites 'none' and 'full' to the same format.
If none appears anywhere in the list, an empty array is returned.
*/
function parseExpand(expand, mapping) {
    var ret = [];
    
    var paths = expand.split(',');
    var containsFull = false;
    for(var i=0; i<paths.length; i++) {
        var path = paths[i].toLowerCase();
        if(path == 'none') {
            return [];
        } else if(path == 'full') {
            // If this was a list resource full is already handled.
        } else if(path == 'results.href') {
            // If this was a list resource full is already handled.
        } else {
            var prefix = 'results.href.';
            var index = paths[i].indexOf(prefix)
            if(index == 0) {
                var npath = path.substr(prefix.length);
                if(npath && npath.length > 0) {
                    debug(npath);
                    ret.push(npath);
                }
            } else if(index == -1) {
                ret.push(path);
            }
        }
    }    
    debug("** parseExpand() results in :");
    debug(ret);
    
    return ret;
}

/*
Execute expansion on an array of elements.
Takes into account a comma-separated list of property paths.
Currently only one level of items on the elements can be expanded.

So for list resources : 
- results.href.person is OK
- results.href.community is OK
- results.href.person,results.href.community is OK. (2 expansions - but both 1 level)
- results.href.person.address is NOT OK - it has 1 expansion of 2 levels. This is not supported.

For regular resources :
- person is OK
- community is OK
- person,community is OK
- person.address,community is NOT OK - it has 1 expansion of 2 levels. This is not supported.
*/
function executeExpansion(database, elements, mapping, resources, expand) {
    var deferred = Q.defer();
    debug('** executeExpansion()');
    try {    
        if(expand) {
            var paths = parseExpand(expand, mapping);
            if(paths && paths.length > 0) {
                var promises = [];
                for(var i=0; i<paths.length; i++) {
                    var path = paths[i];
                    promises.push(executeSingleExpansion(database, elements, mapping, resources, path));
                }

                Q.allSettled(promises).then(function(results) {
                    debug("allSettled :");
                    debug(results);
                    var errors = [];
                    results.forEach(function(result) {
                        if(result.state == 'rejected') {
                            errors.push(result.reason);
                        }
                    });

                    if(errors.length == 0) {
                        debug('** executeExpansion() resolves.');
                        debug('after expansion :');
                        debug(elements);
                        deferred.resolve();
                    } else {
                        deferred.reject({ 
                            type: 'expansion.failed',
                            status: 404,
                            body: {
                                errors: {
                                    code: 'invalid.expand.value',
                                    description: 'expand=' + expand + ' is not a valid expansion string.'
                                }
                            }
                        });
                    }
                });
            } else {
                deferred.resolve();
            }
        } else {
            // No expand value ? We're done !
            deferred.resolve();
        }
    } catch(e) {
        resolve.reject(e.toString());
    }
    
    return deferred.promise;
}
    
/* express.js application, configuration for roa4node */
exports = module.exports = {
    configure: function (app, postgres, config) {
        configuration = config;
        resources = config.resources;
        logsql = config.logsql;
        pg = postgres;

        // All URLs force SSL and allow cross origin access.
        app.use(forceSecureSockets);
        app.use(allowCrossDomain);

        for (var configIndex = 0; configIndex < resources.length; configIndex++) {
            var mapping = resources[configIndex];
            var url;

            // register schema for external usage. public.
            url = mapping.type + '/schema';
            app.use(url, logRequests);
            app.get(url, function (req, resp) {
                var typeToMapping = typeToConfig(resources);
                var type = '/' + req.route.path.split("/")[1];
                var mapping = typeToMapping[type];

                resp.set('Content-Type', 'application/json');
                resp.send(mapping.schema);
            });

            // register list resource for this type.
            url = mapping.type;
            app.get(url, logRequests, checkBasicAuthentication, function (req, resp) {
                var typeToMapping = typeToConfig(resources);
                var type = '/' + req.route.path.split("/")[1];
                var mapping = typeToMapping[type];
                var columns = sqlColumnNames(mapping);
                var table = mapping.type.split("/")[1];

                var database;
                var countquery;
                var count;
                var query;
                var output;
                var elements;
                pgConnect().then(function(db) {
                    debug("pgConnect ... OK");
                    database = db;
                    var begin = prepare("begin-transaction");
                    begin.sql('BEGIN');
                    return pgExec(database,begin);
                }).then(function() {
                    if(!mapping.public) {
                        debug('* getting security context');
                        return getMe(req);
                    }
                }).then(function(me) {
                    // me == null if no authentication header was sent by the client.
                    if(!mapping.public) {
                        debug("* running config.secure functions");
                        return validateAccessAllowed(mapping,database,req,resp,me);
                    }
                }).then(function() {
                    countquery = prepare();
                    countquery.sql('select count(*) from "' + table + '" where 1=1 ');                    
                    debug('* applying URL parameters to WHERE clause');
                    return applyRequestParameters(mapping, req, countquery, database, true);
                }).then(function () {
                    debug('* executing SELECT COUNT query on database');
                    return pgExec(database, countquery);
                }).then(function (results) {
                    count = parseInt(results.rows[0].count);
                    query = prepare();
                    query.sql('select ' + columns + ' from "' + table + '" where 1=1 ');
                    debug('* applying URL parameters to WHERE clause');
                    return applyRequestParameters(mapping, req, query, database, false);
                }).then(function() {    
                    // All list resources support orderby, limit and offset.
                    var orderby = req.query.orderby;
                    var descending = req.query.descending;
                    if (orderby) {
                        var valid = true;
                        var orders = orderby.split(",");
                        for (var o = 0; o < orders.length; o++) {
                            var order = orders[o];
                            if (!mapping.map[order]) {
                                valid = false;
                                break;
                            }
                        }
                        if (valid) {
                            query.sql(" order by " + orders);
                            if (descending) query.sql(" desc");
                        } else {
                            cl("Can not order by [" + orderby + "]. One or more unknown properties. Ignoring orderby.");
                        }
                    }

                    if (req.query.limit) query.sql(" limit ").param(req.query.limit);
                    if (req.query.offset) query.sql(" offset ").param(req.query.offset);

                    debug('* executing SELECT query on database');
                    return pgExec(database, query);
                }).then(function (result) {
                    debug("pgExec select ... OK");
                    debug(result);
                    var rows = result.rows;
                    var results = [];
                    elements = [];
                    for (var row = 0; row < rows.length; row++) {
                        var currentrow = rows[row];

                        var element = {
                            href: mapping.type + '/' + currentrow.guid
                        };

                        // full, or any set of expansion values that must 
                        // all start with "results.href" or "results.href.*" will result in inclusion
                        // of the regular resources in the list resources.
                        if (!req.query.expand || (req.query.expand == 'full' || req.query.expand.indexOf('results.href') == 0)) {
                            element.$$expanded = {
                                $$meta: {
                                    permalink: mapping.type + '/' + currentrow.guid
                                }
                            };
                            mapColumnsToObject(resources, mapping, currentrow, element.$$expanded);
                            executeOnFunctions(resources, mapping, "onread", element.$$expanded);
                            elements.push(element.$$expanded);
                        } else if(req.query.expand && req.query.expand == 'none') {
                            // Intentionally left blank.
                        } else if(req.query.expand) {
                            // Error expand must be either 'full','none' or start with 'href'
                            var msg = "expand value unknown : " + req.query.expand;
                            debug(msg);
                            throw new Error(msg);
                        }
                        results.push(element);
                    }

                    output = {
                        $$meta: {
                            count: count,
                            schema: mapping.type + '/schema'
                        },
                        results: results
                    };
                    debug('* executing expansion : ' + req.query.expand);
                    return executeExpansion(database, elements, mapping, resources, req.query.expand);
                }).then(function() {
                    debug('* executing afterread functions on results');
                    debug(elements);
                    return executeAfterReadFunctions(database, elements, mapping);
                }).then(function() {
                    debug('* sending response to client :');
                    debug(output);
                    resp.set('Content-Type', 'application/json');
                    resp.send(output);
                    resp.end();
                    
                    debug('* rolling back database transaction, GETs never have a side effect on the database.');
                    database.client.query("ROLLBACK", function (err) {
                        // If err is defined, client will be removed from pool.
                        database.done(err);
                    });
                    database.done();
                }).fail(function(error) {
                    database.client.query("ROLLBACK", function (err) {
                        // If err is defined, client will be removed from pool.
                        database.done(err);
                    });
                    
                    if(error.type && error.status && error.body) {
                        resp.status(error.status).send(error.body);
                        database.done();
                        resp.end();
                    } else {
                        cl("GET processing had errors. Removing pg client from pool. Error : ");
                        if(error.stack) {
                            cl(error.stack);
                        } else {
                            cl(error);
                        }
                        database.done(error);
                        resp.status(500).send("Internal Server Error. [" + error.toString() + "]");
                        resp.end();
                    }
                });
            }); // app.get - list resource

            // register single resource
            url = mapping.type + '/:guid';
            app.route(url).get(logRequests, checkBasicAuthentication, function (req, resp) {
                var typeToMapping = typeToConfig(resources);
                var type = '/' + req.route.path.split("/")[1];
                var mapping = typeToMapping[type];
                var guid = req.params.guid;

                var database;
                var element;
                var elements;
                pgConnect().then(function(db) {
                    database = db;
                    if(!mapping.public) {
                        debug('* getting security context');
                        return getMe(req);
                    }
                }).then(function(me) {
                    // me == null if no authentication header was sent by the client.
                    if(!mapping.public) {
                        debug("* running config.secure functions");
                        return validateAccessAllowed(mapping,database,req,resp,me);
                    }
                }).then(function() {
                    debug("* query by guid");
                    return queryByGuid(resources, database, mapping, guid);
                }).then(function(result) {
                    element = result;
                    element.$$meta = {permalink: mapping.type + '/' + guid};
                    elements = [];
                    elements.push(element);
                    debug('* executing expansion : ' + req.query.expand);
                    return executeExpansion(database, elements, mapping, resources, req.query.expand);
                }).then(function() {
                    debug('* executing afterread functions');
                    return executeAfterReadFunctions(database, elements, mapping);
                }).then(function() {
                    debug('* sending response to the client :');
                    debug(element);
                    resp.set('Content-Type', 'application/json');
                    resp.send(element);
                    database.done();
                    resp.end();
                }).fail(function (error) {
                    if(error.type && error.status && error.body) {
                        resp.status(error.status).send(error.body);
                        database.done();
                        resp.end();
                    } else {
                        cl("GET processing had errors. Removing pg client from pool. Error : ");
                        cl(errors);
                        database.done(errors);
                        resp.status(500).send("Internal Server Error. [" + error.toString() + "]");
                        resp.end();
                    }
                });
            }).put(logRequests, checkBasicAuthentication, function(req, resp) {
                debug("* sri4node PUT processing invoked.");
                var url = req.path;
                pgConnect().then(function (db) {
                    var begin = prepare("begin-transaction");
                    begin.sql('BEGIN');
                    return pgExec(db, begin).then(function () {
                        return executePutInsideTransaction(db, url, req.body);
                    }).then(function () {
                        debug("PUT processing went OK. Committing database transaction.");
                        db.client.query("COMMIT", function (err) {
                            // If err is defined, client will be removed from pool.
                            db.done(err);
                            debug("COMMIT DONE.");
                            resp.send(true);
                            resp.end();
                        });
                    }).fail(function (puterr) {
                        cl("PUT processing failed. Rolling back database transaction. Error was :");
                        cl(puterr);
                        db.client.query("ROLLBACK", function (rollbackerr) {
                            // If err is defined, client will be removed from pool.
                            db.done(rollbackerr);
                            cl("ROLLBACK DONE.");
                            resp.status(409).send(puterr);
                            resp.end();
                        });
                    });
                }); // pgConnect
            }).delete(logRequests, checkBasicAuthentication, function (req, resp) {
                debug('sri4node DELETE invoked');
                var typeToMapping = typeToConfig(resources);
                var type = '/' + req.route.path.split("/")[1];
                var mapping = typeToMapping[type];
                var table = mapping.type.split("/")[1];

                pgConnect().then(function (db) {
                    var begin = prepare("begin-transaction");
                    begin.sql("BEGIN");
                    return pgExec(db, begin).then(function () {
                        var deletequery = prepare("delete-by-guid-" + table);
                        deletequery.sql('delete from "' + table + '" where "guid" = ').param(req.params.guid);

                        return pgExec(db, deletequery).then(function (results) {
                            if(results.rowCount != 1) {
                                debug("No row affected ?!");
                                var deferred = Q.defer();
                                deferred.reject("No row affected.");
                                return deferred.promise();
                            } else {
                                return postProcess(mapping.afterdelete, db, req.route.path);
                            }
                        }); // pgExec delete
                    }).then(function () {
                        debug("DELETE processing went OK. Committing database transaction.");
                        db.client.query("COMMIT", function (err) {
                            // If err is defined, client will be removed from pool.
                            db.done(err);
                            debug("COMMIT DONE.");
                            resp.send(true);
                            resp.end();
                        });
                    }).fail(function (delerr) {
                        cl("DELETE processing failed. Rolling back database transaction. Error was :");
                        cl(delerr);
                        db.client.query("ROLLBACK", function (rollbackerr) {
                            // If err is defined, client will be removed from pool.
                            db.done(rollbackerr);
                            cl("ROLLBACK DONE. Sending 500 Internal Server Error. [" + delerr.toString() + "]");
                            resp.status(500).send("Internal Server Error. [" + delerr.toString() + "]");
                            resp.end();
                        });
                    });
                }); // pgConnect
            }); // app.delete
        } // for all mappings.

        url = '/batch';
        app.put(url, logRequests, checkBasicAuthentication, function(req, resp) {
            // An array of objects with 'href', 'verb' and 'body'
            var batch = req.body;
            batch.reverse();

            pgConnect().then(function (db) {
                var begin = prepare('begin-transaction');
                begin.sql("BEGIN");
                return pgExec(db, begin).then(function () {
                    var promises = [];

                    function recurse(batch) {
                        if(batch.length > 0) {
                            var element = batch.pop();
                            var url = element.href;
                            cl("executing /batch section " + url);
                            var body = element.body;
                            var verb = element.verb;
                            if(verb === "PUT") {
                                return executePutInsideTransaction(db, url, body).then(function() {
                                    return recurse(batch);
                                });
                            } else {
                                cl("UNIMPLEMENTED - /batch ONLY SUPPORTS PUT OPERATIONS !!!");
                                throw new Error();
                            }
                        }
                    }

                    return recurse(batch);
                }) // pgExec(db,SQL("BEGIN")...
                    .then(function () {
                        cl("PUT processing went OK. Committing database transaction.");
                        db.client.query("COMMIT", function (err) {
                            // If err is defined, client will be removed from pool.
                            db.done(err);
                            cl("COMMIT DONE.");
                            resp.send(true);
                            resp.end();
                        });
                    })
                    .fail(function (puterr) {
                        cl("PUT processing failed. Rolling back database transaction. Error was :");
                        cl(puterr);
                        db.client.query("ROLLBACK", function (rollbackerr) {
                            // If err is defined, client will be removed from pool.
                            db.done(rollbackerr);
                            cl("ROLLBACK DONE.");
                            resp.status(500).send(puterr);
                            resp.end();
                        });
                    });
            }); // pgConnect
        }); // app.put('/batch');

        url = '/me';
        app.get(url, logRequests, checkBasicAuthentication, function (req, resp) {
            getMe(req).then(function(me) {
                resp.set('Content-Type', 'application/json');
                resp.send(me);
            }).fail(function() {
                resp.status(500).send("Internal Server Error. [" + error.toString() + "]");
                resp.end();
            });
        });

        app.put('/log', function (req, resp) {
            var error = req.body;
            cl("Client side error :");
            var lines = error.stack.split("\n");
            for(var i=0; i<lines.length; i++) {
                cl(lines[i]);
            }
            resp.end();
        });
    },

    utils: {
        // Call this is you want to clear the password and identity cache for the API.
        clearPasswordCache : function() {
            knownPasswords = {};
            knownIdentities = {};
        },

        // Utility to run arbitrary SQL in validation, beforeupdate, afterupdate, etc..
        executeSQL : pgExec,
        prepareSQL : prepare
    },
    
    queryUtils: {
        filterHrefs : function (value, query) {
            var deferred = Q.defer();
            try {
                debug(value);
                var permalinks, guids, i;

                if (value) {
                    permalinks = value.split(",");
                    guids = [];
                    var reject = false;
                    for (i = 0; i < permalinks.length; i++) {
                        var guid = permalinks[i].split('/')[2];
                        if(guid.length == 36) {
                            guids.push(guid);
                        } else {
                            deferred.reject({ code: "parameter." + param + ".invalid.value" });
                            reject = true;
                            break;
                        }
                    }
                    if(!reject) {
                        query.sql(' and guid in (').array(guids).sql(') ');
                        deferred.resolve();
                    }
                }
            } catch(error) {
                debug(error.stack);
                deferred.reject({ code: 'internal.error', description: error.toString() });
            }
            
            return deferred.promise;
        },
    
        // filterReferencedType('/persons','person')
        filterReferencedType : function (resourcetype, columnname) {
            return function (value, query) {
                var deferred = Q.defer();
                
                var permalinks, guids, i;

                if (value) {
                    debug('** filterReferencedType');
                    debug('** resourcetype = [' + resourcetype + ']');
                    permalinks = value.split(",");
                    debug('** permalinks : ');
                    debug(permalinks);
                    guids = [];
                    var reject = false;
                    for (i = 0; i < permalinks.length; i++) {
                        if(permalinks[i].indexOf(resourcetype + "/") === 0) {
                            var guid = permalinks[i].substr(resourcetype.length + 1);
                            if(guid.length == 36) {
                                guids.push(guid);
                            } else {
                                deferred.reject({ code: "parameter.invalid.value" });
                                reject = true;
                                break;
                            }
                        } else {
                            deferred.reject({ code: "parameter.invalid.value" });
                            reject = true;
                            break;
                        }
                    }
                    if(!reject) {
                        query.sql(' and ' + columnname + ' in (').array(guids).sql(') ');
                        deferred.resolve();
                    }
                }
                
                return deferred.promise;
            }
        },
        
        filterILike: function(columnname) {
            return function(value, select) {
                var deferred = Q.defer();
                
                if (value) {
                    var values = value.split(',');
                    select.sql(' AND (');
                    for(var i=0; i<values.length; i++) {
                        if(i>0) select.sql(' OR ');
                        select.sql(columnname + ' ILIKE ').param('%' + values[i] + '%');
                    }
                    select.sql(') ');
                    deferred.resolve();
                } else {
                    deferred.resolve();
                }
                
                return deferred.promise;
            }
        },
        
        filterIn: function(columnname) {
            return function(value, select) {
                var deferred = Q.defer();
                
                if(value) {
                    var values = value.split(',');
                    select.sql(' AND ' + columnname + ' IN (').array(values).sql(') ');
                    deferred.resolve();
                } else {
                    deferred.resolve();
                }
                
                return deferred.promise;
            }
        }
    },

    mapUtils : {
        removeifnull : function(key, e) {
            if(e[key] == null) delete e[key];
        },
        remove : function(key, e) {
            delete e[key];
        },
        now : function(key, e) {
            e[key] = new Date().toISOString();
        },
        value : function(value) {
            return function(key, e) {
                e[key] = value;
            };
        },
        parse : function(key, e) {
            e[key] = JSON.parse(e[key]);
        },
        stringify : function(key, e) {
            e[key] = JSON.stringify(e[key]);
        }
    },

    schemaUtils : {
        permalink: function(type, description) {
            var parts = type.split("/");
            var name = parts[1];

            return {
                type: "object",
                properties: {
                    href: {
                        type: "string",
                        pattern: "^\/" + name + "\/[-0-9a-f].*$",
                        minLength: name.length + 38,
                        maxLength: name.length + 38,
                        description: description
                    }
                },
                required: ["href"]
            };
        },

        string: function(description, min, max) {
            ret = {
                type: "string",
                description: description
            };
            if(min) ret.minLength = min;
            if(max) ret.maxLength = max;
            return ret;
        },

        numeric: function(description) {
            return {
                type: "numeric",
                multipleOf: "1.0",
                description: description
            }
        },

        email: function(description) {
            return {
                type: "string",
                format: "email",
                minLength: 1,
                maxLength: 254,
                description: description
            }
        },

        url: function(description) {
            return {
                type: "string",
                minLength: 1,
                maxLength: 2000,
                format: "uri",
                description: description
            }
        },

        belgianzipcode: function(description) {
            return {
                type: "string",
                pattern: "^[0-9][0-9][0-9][0-9]$",
                description: description
            };
        },

        phone: function(description) {
            return {
                type: "string",
                pattern: "^[0-9]*$",
                minLength: 9,
                maxLength: 10,
                description: description
            };
        },

        timestamp : function(description) {
            return {
                type: "string",
                format: "date-time",
                description: description
            }
        },

        boolean : function(description) {
            return {
                type: "boolean",
                description: description
            }
        }
    }
}
