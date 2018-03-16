const http = require('http');
const crypto = require('crypto');
const qs = require('querystring');
const async = require('async');
const pm2 = require('pm2');
const vizion = require('vizion');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const Tester = require('./tester');
const server = require('./server');
const logger = require('./logger');

const {
	logCallback,
	reqToAppName,
	spawnAsExec,
} = require('./helpers');

const adapter = new FileSync('db.json');
const db = low(adapter);
const oldSpawns = {};

/**
 * @class Worker Class
 */
class Worker {
	/**
	 * @typedef {Object} TestOptions
 	 * @property {string} testCmd
	 * @property {string} reportPath
	 * @property {string} lastGoodCommit
	 * @property {boolean} deployAnyway
	 */

	/**
	 * @typedef {Object} AppOptions
	 * @property {string} secret
	 * @property {string} prehook
	 * @property {string} posthook
	 * @property {string} service
	 * @property {TestOptions} tests
	 * @property {{token: string, remoteUrl: string}} git
	 * @property {{src: string, dest: string}} privateConfig
	 */

	/**
	 * @typedef {Object} ModuleOptions
	 * @property {Object.<string, AppOptions>} apps Object with App names as keys,
	 * and options as values
	 * @property {string} host
	 * @property {Object} slack
	 * @property {string} slack.webhook
	 * @property {string} slack.channel
	 * @property {string} logsDir
	 * @property {Number} port
	 */

	/**
	 * Constructor of our worker
	 *
	 * @constructor
	 * @param {ModuleOptions} opts The options
	 * @returns {Worker} The instance of our worker
	 */
	constructor(opts) {
		/**
		 * @member {ModuleOptions} opts
		 * @member {Number} port
		 * @member {Object.<string, AppOptions>} apps
		 */
		if (typeof (opts.apps) !== 'object') {
			opts.apps = JSON.parse(opts.apps);
		}
		this.opts = opts;
		this.port = opts.port || 8888;
		this.apps = opts.apps;
		this.server = http.createServer(server.bind(this));
		const apps = {};
		Object.keys(opts.apps).forEach((app) => {
			apps[app] = {
				bisectHistory: {},
			};
		});
		db.defaults(apps).write();
		return this;
	}

	/**
	 * Will check the request for validity, and parse all required data
	 * @param req The Request of the call
	 * @param checkRequest If we need to check the request validity (for manual triggering)
	 */
	handleRequest(req, checkRequest = true) {
		const targetName = reqToAppName(req);
		if (targetName.length === 0) return;

		if (!oldSpawns[targetName]) oldSpawns[targetName] = {};

		const targetApp = this.apps[targetName];
		if (!targetApp) {
			logger.log(`Received invalid request, app ${targetName} not present in config:apps`);
			return;
		}
		let git;
		try {
			git = checkRequest ? this.checkRequest(targetApp, req) : undefined;
		}
		catch (error) {
			logger.log('App: %s\nError: %s', targetName, JSON.stringify(error));
			return;
		}

		logger.log('Received valid hook for app %s', targetName);

		this.processRequest(targetApp, targetName, git);
	}

	/**
	 * Main function of the module
	 * @param {AppOptions} targetApp
	 * @param {string} targetName
	 * @param {VersioningInfo} git
	 */
	processRequest(targetApp, targetName, git) {
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
				if (!targetApp.tests) {
					return;
				}
				let res = {};

				const describe = await new Promise((resolve, reject) => {
					pm2.describe(targetName, (err, apps) => {
						if (err || !apps || apps.length === 0) return reject(new Error('Application not found'));
						return resolve(apps);
					});
				});
				const versioning = describe[0].pm2_env.versioning;

				try {
					const tester = await new Tester(
						Object.assign({}, versioning, git, targetApp.git),
						this.opts,
						targetName
					).init();
					logger.log('Cloned repo to tmpdir for testing of app ', targetName);

					logger.log('Starting tests for application %s, on latest commit %s', targetName, (await tester.repo.getHead()).short);
					res = await tester.test();
				}
				catch (e) {
					logger.error(e);
				}

				if (!res.pass && targetApp.tests.deployAnyway) {
					logger.error(`Tests failed for app ${targetName} on latest commit, found bad commit: ${res.commit.short}`);
					return;
				}
				else if (!res.pass) {
					throw new Error(`Tests failed for app ${targetName} on latest commit, found bad commit: ${res.commit.short}`);
				}
				logger.log('All tests passing on latest commit, %s for application %s, pulling', res.commit.short, targetName);

				if (targetApp.tests.lastGoodCommit !== res.commit.hash) {
					// Update lastGoodCommit in pm2 config and for current object
					this.opts.apps[targetName].tests.lastGoodCommit = res.commit.hash;
					this.apps[targetName].tests.lastGoodCommit = res.commit.hash;
					targetApp.tests.lastGoodCommit = res.commit.hash;

					await new Promise(resolve => pm2.set('pm2-githook2:apps', this.apps, resolve));
					logger.log(`Updated lastGoodCommit for app ${targetName} to ${res.commit.short}`);
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
					logger.error('App : %s\n%s', targetName, err);
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
		let git;
		switch (targetApp.service) {
			case 'github':
			default: {
				if (!req.headers['x-github-event'] || !req.headers['x-hub-signature']) {
					throw new Error('Received invalid request for app %s (no headers found)', targetName);
				}

				// compute hash of body with secret, github should send this to verify authenticity
				const temp = crypto.createHmac('sha1', targetApp.secret);
				temp.update(req.body, 'utf-8');
				const hash = temp.digest('hex');
				if ('sha1=' + hash !== req.headers['x-hub-signature']) {
					throw new Error('Received invalid request for app %s', targetName);
				}

				const body = JSON.parse(qs.parse(req.body).payload);
				git = {
					head: body.head_commit.id,
					remoteUrl: body.repository.clone_url,
					tree: body.head_commit.tree_id,
					compare: body.compare,
				};
				break;
			}
		}
		return git;
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
