const http = require('http');
const crypto = require('crypto');
const qs = require('querystring');
const pm2 = require('pm2');
const vizion = require('vizion');

const Tester = require('./tester');
const server = require('./server');
const logger = require('./logger');

const {
	spawnAsExec,
} = require('./helpers');


/**
 * @class Worker Class
 */
class Worker {
	/**
	 * @typedef {Object} TestOptions
 	 * @property {string} testCmd
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
	 * @property {string} dataDir
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
	 * @param {Boolean} deploy Treat manualHook as github request and do all phases
	 * (for manual triggering)
	 */
	async handleRequest(ctx, manualHook = false, deploy = false) {
		const targetName = ctx.state.appName;
		if (targetName.length === 0) return;

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
		await this.processRequest(targetApp, targetName, git, {
			manualHook,
			deploy,
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
	 * @param {Boolean} opts.deploy
	 * @param {Boolean} opts.sendSlack
	 */
	async processRequest(targetApp, targetName, git, opts) {
		const execOptions = {
			cwd: targetApp.cwd,
			env: process.env,
			shell: true,
		};
		let describe;

		const phases = {
			resolveCWD: async () => {
				// if cwd is provided, we expect that it isnt a pm2 app
				if (targetApp.cwd) {
					return;
				}

				// try to get the cwd to execute it correctly
				targetApp.cwd = describe[0].pm_cwd ? describe[0].pm_cwd : describe[0].pm2_env.pm_cwd;
				execOptions.cwd = targetApp.cwd;
			},

			// Run tests
			testRunner: async () => {
				if (!targetApp.tests) {
					return;
				}
				let res = {};

				const versioning = describe[0].pm2_env.versioning;

				const tester = await new Tester(
					Object.assign({}, versioning, git, {token: targetApp.tests.githubToken}),
					this.opts,
					targetName
				).init();

				res = await tester.test(opts);

				if (!res.pass && targetApp.tests.deployAnyway) {
					logger.error(`[${targetName}] [${res.commit && res.commit.short}] Tests failed for app, ` +
						`found bad commit: ${res.bisect && res.bisect.commit && res.bisect.commit.short}.` +
						opts.manualHook && !opts.deploy ? '' : 'Deploying anyway due to config');
				}
				else if (!res.pass) {
					throw new Error(`Tests failed for app on commit ${res.commit && res.commit.short}, ` +
						`found bad commit: ${res.bisect && res.bisect.commit && res.bisect.commit.short}`);
				}
				else {
					logger.log('[%s] [%s] All tests passing. %s', targetName, res.commit.short,
						opts.manualHook && !opts.deploy ? 'Manual Hook - not pulling' : 'Pulling');
				}
			},

			pullTheApplication: async () => {
				await new Promise((resolve, reject) => {
					vizion.update({
						folder: targetApp.cwd,
					}, (err) => {
						if (err) reject(err);
						else resolve();
					});
				});
				logger.log('[%s] Successfuly pulled application', targetName);
			},

			preHook: async () => {
				if (!targetApp.prehook) {
					return;
				}
				await spawnAsExec(targetApp.prehook, targetName, execOptions);
				logger.log('[%s] Prehook command has been successfuly executed', targetName);
			},

			reloadApplication: async () => {
				if (targetApp.nopm2) {
					return;
				}
				await new Promise((resolve, reject) => {
					pm2.gracefulReload(targetName, (err) => {
						if (err) reject(err);
						else resolve();
					});
				});
				logger.log('[%s] Successfuly reloaded application', targetName);
			},

			postHook: async () => {
				if (!targetApp.posthook) {
					return;
				}
				// execute the actual command in the cwd of the application
				await spawnAsExec(targetApp.posthook, targetName, execOptions);
				logger.log('[%s] Posthook command has been successfuly executed', targetName);
			},
		};
		try {
			describe = await new Promise((resolve, reject) => {
				pm2.describe(targetName, (err, apps) => {
					if (err || !apps || apps.length === 0) return reject(new Error('Application not running in pm2'));
					return resolve(apps);
				});
			});
			await phases.resolveCWD();
			await phases.testRunner();
			if (opts.manualHook && !opts.deploy) {
				logger.log('[%s] Only Running tests. Manual Hook', targetName);
			}
			else {
				await phases.pullTheApplication();
				await phases.preHook();
				await phases.reloadApplication();
				await phases.postHook();
			}
			logger.log('[%s] Done!', targetName);
		}
		catch (err) {
			logger.log('[%s] An error has occuring while processing app', targetName);
			logger.error('[%s] %s', targetName, err);
		}
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
		let git;
		switch (targetApp.service) {
			case 'github':
			default: {
				if (!ctx.get('x-github-event') || !ctx.get('x-hub-signature')) {
					throw new Error('Received invalid request for app (no headers found)');
				}

				// compute hash of body with secret, github should send this to verify authenticity
				const temp = crypto.createHmac('sha1', targetApp.secret);
				temp.update(ctx.request.body, 'utf-8');
				const hash = temp.digest('hex');
				if ('sha1=' + hash !== ctx.get('x-hub-signature')) {
					throw new Error('Received invalid request for app');
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
