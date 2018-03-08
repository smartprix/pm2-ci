const http = require('http');
const crypto = require('crypto');
const util = require('util');
const async = require('async');
const pm2 = require('pm2');
const vizion = require('vizion');
const ipaddr = require('ipaddr.js');

const tester = require('./tester');
const server = require('./server');
const logger = require('./logger');

const {
	logCallback,
	reqToAppName,
	spawnAsExec,
	localeDateString,
} = require('./helpers');

const oldSpawns = {};

class Worker {
	/**
	 * Constructor of our worker
	 *
	 * @param {object} opts The options
	 * @returns {Worker} The instance of our worker
	 * @constructor
	 */
	constructor(opts) {
		if (!(this instanceof Worker)) {
			return new Worker(opts);
		}

		this.opts = opts;
		this.port = opts.port || 8888;
		this.apps = opts.apps;

		if (typeof (this.apps) !== 'object') {
			this.apps = JSON.parse(this.apps);
		}

		this.server = http.createServer(server.bind(this));
		return this;
	}

	/**
	 * Main function of the module
	 *
	 * @param req The Request of the call
	 */
	processRequest(req) {
		const targetName = reqToAppName(req);
		if (targetName.length === 0) return;

		if (!oldSpawns[targetName]) oldSpawns[targetName] = {};

		const targetApp = this.apps[targetName];
		if (!targetApp) return;

		const error = this.checkRequest(targetApp, req);
		if (error) {
			logger.log('App: %s\nError: %s', targetName, JSON.stringify(error));
			return;
		}

		logger.log('Received valid hook for app %s', targetName);

		const execOptions = {
			cwd: targetApp.cwd,
			env: process.env,
			shell: true,
		};
		const phases = {
			resolveCWD: (cb) => {
			// if cwd is provided, we expect that it isnt a pm2 app
				if (targetApp.cwd) {
					cb();
					return;
				}

				// try to get the cwd to execute it correctly
				pm2.describe(targetName, (err, apps) => {
					if (err || !apps || apps.length === 0) return cb(err || new Error('Application not found'));

					// execute the actual command in the cwd of the application
					targetApp.cwd = apps[0].pm_cwd ? apps[0].pm_cwd : apps[0].pm2_env.pm_cwd;
					return cb();
				});
			},

			// Run tests
			testRunner: async () => {
				const describe = await new Promise((resolve, reject) => {
					pm2.describe(targetName, (err, apps) => {
						if (err || !apps || apps.length === 0) return reject(new Error('Application not found'));
						return resolve(apps);
					});
				});
				const versioning = describe[0].pm2_env.versioning;

				logger.log('Starting tests for application %s', targetName);

				let res;
				try {
					res = await tester({
						git: versioning,
						app: targetApp,
						appName: targetName,
						reportsDir: `${this.opts.logsDir}/test-reports/${targetName}`,
					});
				}
				catch (e) {
					logger.error(e);
				}

				if (!res.pass) {
					logger.error(`Tests failed for app ${targetName} on latest commit, found bad commit: ${res.commit}`);
					throw res.err;
				}
				logger.log('All tests passing on latest commit for application %s, pulling', targetName);
				if (targetApp.tests.lastGoodCommit !== res.commit) {
					// Update lastGoodCommit in pm2 config
					this.opts.apps[targetName].tests.lastGoodCommit = res.commit;
					this.apps[targetName].tests.lastGoodCommit = res.commit;
					targetApp.tests.lastGoodCommit = res.commit;

					await new Promise(resolve => pm2.set('pm2-githook2:apps', this.opts.apps, resolve));
					logger.log(`Updated lastGoodCommit for app ${targetName} to ${res.commit}`);
				}
			},

			pullTheApplication: (cb) => {
				vizion.update({
					folder: targetApp.cwd,
				}, logCallback(cb, 'Successfuly pulled application %s', targetName));
			},

			preHook: (cb) => {
				if (!targetApp.prehook) {
					cb();
					return;
				}

				const oldChild = oldSpawns[targetName].prehook;
				if (oldChild) logCallback(oldChild.kill, 'Killed old prehook process as new request received %s', targetName);

				const child = spawnAsExec(targetApp.prehook, execOptions,
					logCallback(() => {
						oldSpawns[targetName].prehook = undefined;
						cb();
					}, 'Prehook command has been successfuly executed for app %s', targetName),
				);

				oldSpawns[targetName].prehook = child;
			},

			reloadApplication: (cb) => {
				if (targetApp.nopm2) {
					cb();
					return;
				}
				pm2.gracefulReload(targetName,
					logCallback(cb, 'Successfuly reloaded application %s', targetName));
			},

			postHook: (cb) => {
				if (!targetApp.posthook) {
					cb();
					return;
				}
				// execute the actual command in the cwd of the application
				spawnAsExec(targetApp.posthook, execOptions,
					logCallback(cb, 'Posthook command has been successfuly executed for app %s', targetName));
			},
		};
		async.series(Object.keys(phases).map(k => phases[k]),
			(err) => {
				if (err) {
					logger.log('An error has occuring while processing app %s', targetName);
					logger.error('App : %s\nError: %s', targetName, JSON.stringify(err));
				}
			}
		);
	}

	/**
	 * Checks if a request is valid for an app.
	 *
	 * @param targetApp The app which the request has to be valid
	 * @param req The request to analyze
	 * @returns {string|true} True if success or the string of the error if not.
	*/
	// eslint-disable-next-line
	checkRequest(targetApp, req) {
		const targetName = reqToAppName(req);

		switch (targetApp.service) {
			case 'gitlab': {
				if (!req.headers['x-gitlab-token']) {
					return util.format('Received invalid request for app %s (no headers found)', targetName);
				}

				if (req.headers['x-gitlab-token'] !== targetApp.secret) {
					return util.format('Received invalid request for app %s (not matching secret)', targetName);
				}
				break;
			}
			case 'jenkins': {
				// ip must match the secret
				if (req.ip.indexOf(targetApp.secret) < 0) {
					return util.format('Received request from %s for app %s but ip configured was %s', req.ip, targetName, targetApp.secret);
				}

				const body = JSON.parse(req.body);
				if (body.build.status !== 'SUCCESS') {
					return util.format('Received valid hook but with failure build for app %s', targetName);
				}
				if (targetApp.branch && body.build.scm.branch.indexOf(targetApp.branch) < 0) {
					return util.format('Received valid hook but with a branch %s than configured for app %s', body.build.scm.branch, targetName);
				}
				break;
			}
			case 'droneci': {
				// Authorization header must match configured secret
				if (!req.headers.Authorization) {
					return util.format('Received invalid request for app %s (no headers found)', targetName);
				}
				if (req.headers.Authorization !== targetApp.secret) {
					return util.format('Received request from %s for app %s but incorrect secret', req.ip, targetName);
				}

				const data = JSON.parse(req.body);
				if (data.build.status !== 'SUCCESS') {
					return util.format('Received valid hook but with failure build for app %s', targetName);
				}
				if (targetApp.branch && data.build.branch.indexOf(targetApp.branch) < 0) {
					return util.format('Received valid hook but with a branch %s than configured for app %s', data.build.branch, targetName);
				}
				break;
			}
			case 'bitbucket': {
				const tmp = JSON.parse(req.body);
				const ip = targetApp.secret || '104.192.143.0/24';
				const configured = ipaddr.parseCIDR(ip);
				const source = ipaddr.parse(req.ip);

				if (!source.match(configured)) {
					return util.format('Received request from %s for app %s but ip configured was %s', req.ip, targetName, ip);
				}
				if (!tmp.push) {
					return util.format("Received valid hook but without 'push' data for app %s", targetName);
				}
				if (targetApp.branch && tmp.push.changes[0] &&
						tmp.push.changes[0].new.name.indexOf(targetApp.branch) < 0) {
					return util.format('Received valid hook but with a branch %s than configured for app %s', tmp.push.changes[0].new.name, targetName);
				}
				break;
			}
			case 'github':
			default: {
				if (!req.headers['x-github-event'] || !req.headers['x-hub-signature']) {
					return util.format('Received invalid request for app %s (no headers found)', targetName);
				}

				// compute hash of body with secret, github should send this to verify authenticity
				const temp = crypto.createHmac('sha1', targetApp.secret);
				temp.update(req.body, 'utf-8');
				const hash = temp.digest('hex');

				if ('sha1=' + hash !== req.headers['x-hub-signature']) {
					return util.format('Received invalid request for app %s', targetName);
				}
				break;
			}
		}
		return false;
	}

	/**
	 * Lets start our server
	 */
	start() {
		const self = this;
		this.server.listen(this.opts.port, () => {
			logger.log('Server is ready and listen on port %s', self.port);
		});
	}
}

module.exports = Worker;
