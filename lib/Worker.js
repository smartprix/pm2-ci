const http = require('http');
const crypto = require('crypto');
const qs = require('querystring');
const pm2 = require('pm2');
const vizion = require('vizion');

const Tester = require('./tester');
const server = require('./server');
const slack = require('./slack');
const logger = require('./logger');

const {spawnAsExec} = require('./helpers');

/**
 * @class Worker Class
 */
class Worker {
	/**
	 * @typedef {Object} TestOptions
 	 * @property {string} testCmd
	 * @property {string} lastGoodCommit
	 * @property {boolean} deployAnyway
	 * @property {string} githubToken
	 * @property {string} privateConfig
	 */

	/**
	 * @typedef {Object} AppOptions
	 * @property {string} secret
	 * @property {string} prehook
	 * @property {string} posthook
	 * @property {string} service
	 * @property {string} slackChannel
	 * @property {TestOptions} tests
	 */

	/**
	 * @typedef {Object} ModuleOptions
	 * @property {string} host
	 * @property {string} slackWebhook
	 * @property {string} slackChannel
	 * @property {string} dataDir
	 * @property {Number} port
	 * @property {Object.<string, AppOptions>} apps Object with App names as keys & options as values
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
		/** @type {ModuleOptions} */
		this.opts = opts;
		/** @type {Number} */
		this.port = opts.port || 8888;
		/** @type {AppOptions} */
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
		if (ctx.state.appName === 0) return;

		let res;
		try {
			res = manualHook ? {git: {head: ctx.query.commit}, targetName: ctx.state.appName} :
				this.checkRequest(ctx.state.appName, ctx);
		}
		catch (error) {
			logger.error('[%s] Error: %s', ctx.state.appName, error.message + '\n' + JSON.stringify(error));
			return;
		}
		const targetApp = this.apps[res.targetName];
		if (!targetApp) {
			logger.log('[%s] Received invalid request, app not present in config:apps', res.targetName);
			return;
		}

		logger.log('[%s] Received valid hook for app', res.targetName);
		await this.processRequest(targetApp, res.targetName, res.git, {
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
		let res;
		let tester;
		let error;
		const deployed = {};

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
				if (!targetApp.tests || !targetApp.tests.testCmd) {
					return;
				}
				const versioning = describe[0].pm2_env.versioning;

				tester = await new Tester(
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
				deployed.pull = true;
				logger.log('[%s] Successfuly pulled application', targetName);
			},

			preHook: async () => {
				if (!targetApp.prehook) {
					return;
				}
				const stdio = await spawnAsExec(targetApp.prehook, execOptions, {
					appName: targetName, commandName: 'preHook', debug: targetApp.debug,
				});
				deployed.pre = {stdio};
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
				deployed.reload = true;
				logger.log('[%s] Successfuly reloaded application', targetName);
			},

			postHook: async () => {
				if (!targetApp.posthook) {
					return;
				}
				// execute the actual command in the cwd of the application
				const stdio = await spawnAsExec(targetApp.posthook, execOptions, {
					appName: targetName, commandName: 'postHook', debug: targetApp.debug,
				});
				deployed.post = {stdio};
				logger.log('[%s] Posthook command has been successfuly executed', targetName);
			},

			sendSlack: async () => {
				if (!opts.sendSlack) {
					return;
				}
				const attachments = [];

				if (res !== undefined) {
					let value;
					if (res.report.passes === undefined) {
						value = '*Tests could not be run. No report generated.*';
					}
					else if (res.report.testsRegistered === res.report.skipped) {
						value = '*Tests timed out!*';
					}
					else {
						value = `*Passed:* ${res.report.passes}\t` +
						`*Failed:* ${res.report.failures}\t` +
						`*Pending:* ${res.report.pending}\t` +
						`*Skipped:* ${res.report.skipped}`;
					}

					attachments.push({
						fallback: `Test report available at ${res.report.url}`,
						title: 'Test Report For:',
						text: `${slack.format.url(res.commit.url, slack.format.code(res.commit.short))} ${res.commit.message} - ${res.commit.author}`,
						fields: [{value}],
						actions: [{
							type: 'button',
							text: 'Changes 🔍',
							url: tester.changes || res.commit.url,
						}, {
							type: 'button',
							text: 'Test Report 📋',
							url: res.report.url,
						}],
						color: res.pass ? 'good' : 'danger',
					});

					if (!res.pass && res.bisect) {
						attachments.push({
							fallback: `Tests started failing at commit ${res.bisect.commit.short}`,
							title: 'Tests Started Failing At:',
							text: `${slack.format.url(res.bisect.commit.url, slack.format.code(res.bisect.commit.short))} ${res.bisect.commit.message} - ${res.bisect.commit.author}`,
							fields: [{
								value: res.bisect.report.passes === undefined ?
									'*Tests could not be run. No report generated.*' :
									`*Passed:* ${res.bisect.report.passes}\t` +
									`*Failed:* ${res.bisect.report.failures}\t` +
									`*Pending:* ${res.bisect.report.pending}\t` +
									`*Skipped:* ${res.bisect.report.skipped}`,
							}],
							actions: [{
								type: 'button',
								text: 'View Commit 🔗',
								url: res.bisect.commit.url,
							}, {
								type: 'button',
								text: 'Test Report 📋',
								url: res.bisect.report.url,
							}],
							color: 'danger',
						});
					}
				}
				if (deployed.pull && deployed.reload) {
					attachments.push({
						fallback: `Deployed app ${targetName}`,
						title: `Pulled app ${targetName} to the latest commit, ${tester.commit}`,
					});
				}
				else if (res && !res.pass && !targetName.tests.deployAnyway) {
					attachments.push({
						fallback: `App ${targetName} not deployed because tests failed`,
						text: `App ${targetName} not deployed because tests failed`,
					});
				}
				else if (res &&	error !== undefined) {
					attachments.push({
						fallback: `App ${targetName} encountered an error`,
						title: `Could not pull app ${targetName} to the latest commit, ${tester.commit}`,
					});
				}

				logger.log('[%s] [%s] %s', targetName, tester.commit,
					await slack.send(`Report for app *${targetName}* :`, attachments, targetApp.slackChannel)
				);
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
			error = err;
			logger.error('[%s] An error has occuring while processing app', targetName);
			logger.error('[%s] %s', targetName, err);
		}
		try {
			await phases.sendSlack();
		}
		catch (err) {
			logger.error('[%s] An error has occuring while sending slack msg for app', targetName);
			logger.error('[%s] %s', targetName, err);
		}
	}

	/**
	 * Checks if a request is valid for an app.
	 *
	 * @param targetName The app which the request has to be valid
	 * @param ctx Koa context object
	 * @returns {string|true} True if success or the string of the error if not.
	*/
	// eslint-disable-next-line
	checkRequest(ctx) {
		const body = JSON.parse(qs.parse(ctx.request.body).payload);
		console.log(body);
		const git = {
			head: body.head_commit.id,
			remoteUrl: body.repository.clone_url,
			tree: body.head_commit.tree_id,
			compare: body.compare,
			branch: body.refs.split('/')[2],
		};
		let targetName;
		if (git.branch !== 'master') {
			targetName += `${ctx.state.appName}-${git.branch}`;
		}
		console.log(git);

		if (!ctx.get('x-github-event') || !ctx.get('x-hub-signature')) {
			throw new Error('Received invalid request for app (no headers found)');
		}

		const targetApp = this.apps[targetName];
		console.log(targetName, targetApp);
		// compute hash of body with secret, github should send this to verify authenticity
		const temp = crypto.createHmac('sha1', targetApp.secret);
		temp.update(ctx.request.body, 'utf-8');
		const hash = temp.digest('hex');
		if ('sha1=' + hash !== ctx.get('x-hub-signature')) {
			throw new Error('Received invalid request for app');
		}

		return {
			git,
			targetName,
		};
	}

	/**
	 * Lets start our server
	 */
	async start(retry = 2) {
		return new Promise((resolve, reject) => {
			this.server.listen(this.port, () => {
				logger.log('[Server] Ready and listening on port %s', this.port);
				resolve(this);
			});

			this.server.on('error', (e) => {
				if (e.code === 'EADDRINUSE' && retry > 0) {
					logger.log('Address in use, retrying...');
					setTimeout(() => {
						this.server.close();
						this.server.listen(this.port, () => {
							logger.log('[Server] Ready and listening on port %s', this.port);
							resolve(this);
						});
						retry -= 1;
					}, 3000);
				}
				else reject(e);
			});
		});
	}
}

module.exports = Worker;
