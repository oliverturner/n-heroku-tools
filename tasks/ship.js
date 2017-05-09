'use strict';

const co = require('co');
const scale = require('./scale').task;
const configure = require('./configure').task;
const packageJson = require(process.cwd() + '/package.json');
const pipelines = require('../lib/pipelines');
const deploy = require('./deploy').task;
const log = require('../lib/logger');

function task (opts) {

	return co(function* (){
		let support = yield pipelines.supported();
		if(!support){
			log.error('Heroku pipelines are not enabled on this system');
			return;
		}


		let appName = packageJson.name.replace('ft-next-', '');
		let pipelineName = opts.pipeline || packageJson.name;
		log.info('Deploy to ' + pipelineName);
		let apps = yield pipelines.getApps(pipelineName);
		if(!apps.staging){
			log.error('No staging app found');
			return;
		}

		if(!apps.production.eu){
			log.error('No EU production app found');
			return;
		}

		if(opts.multiregion && !apps.production.us){
			log.error('No US App Found - add --no-multiregion if it does not exist yet');
			return;
		}

		log.info('Found apps %j', apps);

		if (opts.configure) {
			log.log('Configure enabled');
			let source = pipelineName;
			let configureTasks = [
				configure({ source: source, target: apps.staging, vault: !!opts.vault }),
				configure({ source: source, target: apps.production.eu, overrides: ['REGION=EU'], vault: !!opts.vault })
			];
			if (opts.multiregion) {
				configureTasks.push(configure({ source: source, target: apps.production.us, overrides: ['REGION=US'], vault: !!opts.vault }))
			}

			log.log('Configure all apps');
			yield Promise.all(configureTasks);
			log.success('configure complete');
		}

		log.info('Scale staging app to 1 dyno');
		yield scale({ source: appName, target: apps.staging, minimal: true }).catch(function (){
			log.info('Failed to scale up staging app - is this the first run?')
		});

		log.info('Deploy to staging app and run gtg checks');
		yield deploy({ app: apps.staging, authenticatedSmokeTests: true});
		log.success('Deploy successful');

		log.warn('Enabling of preboot is deprecated because Heroku have changed the API and we had already decided to change the approach');

		log.info('Promote slug to production');
		yield pipelines.promote(apps.staging);
		log.success('Slug promoted');
		if(opts.scale){
			log.log('scale enabled');
			let source = appName;
			let scaleTasks = [
				scale({source:source, target:apps.staging}),
				scale({source:source, target:apps.production.eu})
			];
			if(opts.multiregion){
				scaleTasks.push(scale({source:source, target:apps.production.us}))
			}

			log.info('scale production apps');
			yield Promise.all(scaleTasks);
			log.success('scale complete');
		}

		log.info('scale staging app back to 0');
		yield scale({ source: appName, target: apps.staging, inhibit: true }).catch(() => {
			log.warn('Failed to scale down staging app');
		});

		log.success('Shipped!');
		log.art.ship(appName);
	});
};

module.exports = function (program, utils) {
	program
		.command('ship')
		.description('Ships code.  Deploys using pipelines, also running the configure and scale steps automatically')
		.option('-c --no-configure', 'Skip the configure step')
		.option('-t --vault', 'Use the vault instead of next-config-vars for any configuration')
		.option('-s --no-scale', 'Skip the scale step')
		.option('-p --pipeline [name]', 'The name of the pipeline to deploy to.  Defaults to the app name')
		.option('-m --multiregion', 'Will expect a US app as well as an EU one')
		.action(function (options){
			task(options).catch(utils.exit);
		});
};

module.exports.task = task;
