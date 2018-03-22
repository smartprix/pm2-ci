const http = require('http');
const crypto = require('crypto');
const qs = require('querystring');
const async = require('async');
const pm2 = require('pm2');
const vizion = require('vizion');

const Tester = require('./tester');
const server = require('./server');
const logger = require('./logger');

const {
	logCallback,
	spawnAsExec,
} = require('./helpers');

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
		return this;
	}

	/**
	 * Will check the request for validity, and parse all required data
	 * @param {Object} ctx The koa context object
	 * @param {Boolean} manualHook If we need to check the request validity/ignore DB
	 * (for manual triggering)
	 */
	handleRequest(ctx, manualHook = false) {
		const targetName = ctx.state.appName;
		if (targetName.length === 0) return;

		if (!oldSpawns[targetName]) oldSpawns[targetName] = {};

		const targetApp = this.apps[targetName];
		if (!targetApp) {
			logger.log('[%s] Received invalid request, app not present in config:apps', targetName);
			return;
		}
		let git;
		try {
			git = manualHook ? {head: ctx.query.commit} : this.checkRequest(targetApp, ctx);
		}
		catch (error) {
			logger.log('[%s] Error: %s', targetName, JSON.stringify(error));
			return;
		}

		logger.log('[%s] Received valid hook for app', targetName);
		this.processRequest(targetApp, targetName, git, {
			manualHook,
			sendSlack: !manualHook || ctx.query.slack === 'on',
		});
	}

	/**
	 * Main function of the module
	 * @param {AppOptions} targetApp
	 * @param {string} targetName
	 * @param {VersioningInfo} git
	 * @param {Object} opts
	 * @param {Boolean} opts.manualHook
	 * @param {Boolean} opts.sendSlack
	 */
	processRequest(targetApp, targetName, git, opts) {
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

					res = await tester.test(opts);
				}
				catch (e) {
					throw new Error(`[${targetName}] Error in Tester: ${e}`);
				}

				if (!res.pass && targetApp.tests.deployAnyway) {
					logger.error(`[${targetName}] [${res.commit && res.commit.short}] Tests failed for app, ` +
					`found bad commit: ${res.bisect && res.bisect.commit && res.bisect.commit.short}.` +
					opts.manualHook ? '' : 'Deploying anyway due to config');
					return;
				}
				else if (!res.pass) {
					throw new Error(`Tests failed for app on commit ${res.commit && res.commit.short}, ` +
					`found bad commit: ${res.bisect && res.bisect.commit && res.bisect.commit.short}`);
				}
				logger.log('[%s] [%s] All tests passing. %s', targetName, res.commit.short,
					opts.manualHook ? 'Manual Hook - not pulling' : 'Pulling');

				if (targetApp.tests.lastGoodCommit !== res.commit.hash && !opts.manualHook) {
					// Update lastGoodCommit in pm2 config and for current object
					this.opts.apps[targetName].tests.lastGoodCommit = res.commit.hash;
					this.apps[targetName].tests.lastGoodCommit = res.commit.hash;
					targetApp.tests.lastGoodCommit = res.commit.hash;

					await new Promise(resolve => pm2.set('pm2-githook2:apps', this.apps, resolve));
					logger.log('[%s] [%s] Updated lastGoodCommit', targetName, res.commit.short);
				}
			},

			pullTheApplication: (cb) => {
				vizion.update({
					folder: targetApp.cwd,
				}, logCallback(cb, '[%s] Successfuly pulled application', targetName));
			},

			preHook: (cb) => {
				if (!targetApp.prehook) {
					cb();
					return;
				}

				const oldChild = oldSpawns[targetName].prehook;
				if (oldChild) logCallback(oldChild.kill, '[%s] Killed old prehook process as new request received', targetName);

				const child = spawnAsExec(targetApp.prehook, targetName, execOptions,
					logCallback(() => {
						oldSpawns[targetName].prehook = undefined;
						cb();
					}, '[%s] Prehook command has been successfuly executed', targetName),
				);

				oldSpawns[targetName].prehook = child;
			},

			reloadApplication: (cb) => {
				if (targetApp.nopm2) {
					cb();
					return;
				}
				pm2.gracefulReload(targetName,
					logCallback(cb, '[%s] Successfuly reloaded application', targetName));
			},

			postHook: (cb) => {
				if (!targetApp.posthook) {
					cb();
					return;
				}
				// execute the actual command in the cwd of the application
				spawnAsExec(targetApp.posthook, targetName, execOptions,
					logCallback(cb, '[%s] Posthook command has been successfuly executed', targetName));
			},
		};
		let phasesFunctions;
		if (opts.manualHook) {
			logger.log('[%s] Only Running tests. Manual Hook', targetName);
			phasesFunctions = Object.keys(phases).slice(0, 2).map(k => phases[k]);
		}
		else phasesFunctions = Object.keys(phases).map(k => phases[k]);
		async.series(phasesFunctions,
			(err) => {
				if (err) {
					logger.log('[%s] An error has occuring while processing app', targetName);
					logger.error('[%s] Error: %s', targetName, err);
				}
				else logger.log('[%s] Done!', targetName);
			}
		);
	}

	/**
	 * Checks if a request is valid for an app.
	 *
	 * @param targetApp The app which the request has to be valid
	 * @param ctx Koa context object
	 * @returns {string|true} True if success or the string of the error if not.
	*/
	// eslint-disable-next-line
	checkRequest(targetApp, ctx) {
		const targetName = ctx.state.appName;
		let git;
		switch (targetApp.service) {
			case 'github':
			default: {
				if (!ctx.get('x-github-event') || !ctx.get('x-hub-signature')) {
					throw new Error('Received invalid request for app %s (no headers found)', targetName);
				}

				// compute hash of body with secret, github should send this to verify authenticity
				const temp = crypto.createHmac('sha1', targetApp.secret);
				temp.update(ctx.request.body, 'utf-8');
				const hash = temp.digest('hex');
				if ('sha1=' + hash !== ctx.get('x-hub-signature')) {
					throw new Error('Received invalid request for app %s', targetName);
				}

				const body = JSON.parse(qs.parse(ctx.request.body).payload);
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
	async start() {
		return new Promise((resolve) => {
			this.server.listen(this.port, () => {
				logger.log('[Server] Ready and listening on port %s', this.port);
				resolve(this);
			});
		});
	}
}

module.exports = Worker;
