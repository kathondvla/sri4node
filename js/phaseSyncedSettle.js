const pSettle = require('p-settle')
const pFinally = require('p-finally');
const pEvent = require('p-event');
const uuidv1 = require('uuid/v1');
const EventEmitter = require('events');


debug_log = (debug, id, msg) => {
    if (debug) {
      console.log(`PS -${id}- ${msg}`);
    }
};



PhaseSyncer = class {
    constructor(fun, args, ctrlEmitter, debug ) {
    	this.ctrlEmitter = ctrlEmitter,
    	this.debug = debug,
     	this.id = uuidv1()
     	this.phaseCntr = 0
		this.jobEmitter = new EventEmitter()
		args.unshift(this)
		this.jobPromise = pFinally( fun(...args), () => { this.ctrlEmitter.emit('jobDone', this.id) } )
		debug_log(debug, this.id, 'PhaseSyncer constructed.')
    }

    phase() {
    	debug_log(this.debug, this.id, `STEP ${this.phaseCntr}`); 
    	// Need to construct pEvent promise before sending stepDone, otherwise event 'ready'
    	// might be sent before event handler waiting for 'ready' is set up. 
    	const promise = pEvent(this.jobEmitter, 'ready')
		if (this.phaseCntr > 0) {
  			this.ctrlEmitter.emit('stepDone', this.id, this.phaseCntr)
    	}  	   	
  		this.phaseCntr += 1    	

    	return promise
  	}
}


exports = module.exports = (jobList, {concurrency = 1, debug = false} = {}) => {

	const ctrlEmitter = new EventEmitter()
	const jobMap = new Map(jobList.map( ([fun, args]) => new PhaseSyncer(fun, args, ctrlEmitter, debug) )
							      .map( phaseSyncer => [ phaseSyncer.id, phaseSyncer ] ))
	const jobs = new Set(jobMap.keys())

	let queuedJobs;
	let phasePendingJobs;


	const startNewPhase = () => {
		const jobList = [...jobs.values()]
		jobList.slice(0, concurrency).forEach( id => jobMap.get(id).jobEmitter.emit('ready') )
		queuedJobs = new Set(jobList.slice(concurrency))
		phasePendingJobs = new Set(jobs)
	}

	const startQueuedJob = () => {
		if (queuedJobs.size > 0) {
			const id = queuedJobs.values().next().value
			jobMap.get(id).jobEmitter.emit('ready') 
			queuedJobs.delete(id)
		}
	}



	ctrlEmitter.on('stepDone', listener = function (id, stepnr) {
		debug_log(debug, id,`*step ${stepnr}* done.`)
		phasePendingJobs.delete(id)

		if (phasePendingJobs.size === 0) {
			debug_log(debug, id,` Starting new phase.`)
			startNewPhase()
		} else {
			debug_log(debug, id,` Starting queued job.`)
			startQueuedJob()
		}
	});

	ctrlEmitter.on('jobDone', listener = function (id) {
		debug_log(debug, id, `*JOB* done.`)

		jobs.delete(id)
		queuedJobs.delete(id)
		phasePendingJobs.delete(id)

		if (phasePendingJobs.size === 0) {
			startNewPhase()
		} else {
			startQueuedJob()
		}
	});


	startNewPhase()

	return pSettle( [...jobMap.values()].map( phaseSyncer => phaseSyncer.jobPromise ) )
}