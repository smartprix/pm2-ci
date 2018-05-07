const {URL} = require('url');
const path = require('path');
const http = require('http');
const tmp = require('tmp');
const fse = require('fs-extra');

const Git = require('./git');
const logger = require('./logger');
const slack = require('./slack');
const {getDb} = require('./db');
const {spawnAsExec} = require('./helpers');

/** Class representing a Tester Unit */
class Tester {
	/**
	 * @typedef {Object} VersioningInfo
	 * @property {String} url
	 * @property {String} branch
	 * @property {String} remote 'origin'
	 * @property {String} repo_path
	 * @property {String} head Current head commit hash
	 * @property {String} remoteUrl
	 * @property {String} tree
	 * @property {String} compare Compare before/after commits url
	 */

	/**
	 * Constructor
	 * @param {VersioningInfo} git
	 * @param {Object} opts The pm2 config object for the module
	 * @param {String} appName
	 */
	constructor(git, opts, appName) {
		this.opts = opts;
		this.appName = appName;
		this.app = opts.apps[appName];
		this.git = git;
		/** @type {Git} */
		this.repo = new Git(git);
		return this;
	}

	async init() {
		this.db = await getDb('tests');
		this.tmpDir = await Tester.createTmpDir();
		this.repo = await this.repo.init(this.path);
		this.commit = (await this.repo.getHead()).short;
		logger.log('[%s] [%s] Initialized and cloned. Tmp directory: %s', this.appName, this.commit, this.path);
		return this;
	}

	get path() {
		return this.tmpDir.path;
	}

	get changes() { return this.git.compare }

	get manualHead() { return this.git.head }

	get projectCwd() { return this.app.cwd || this.git.repo_path }

	get testCommand() {
		return `${this.app.tests.testCmd} -- --reporter mochawesome --reporter-options ` +
			'reportDir=testReport,' +
			`reportFilename=${this.appName},` +
			`reportPageTitle='Report for ${this.appName} on commit ${(this.repo.head ? this.repo.head.short : '')}',` +
			`reportTitle='Report for ${this.appName} on commit ${(this.repo.head ? this.repo.head.short : '')}',` +
			'assetsDir=../assets,' +
			'showPassed=false,' +
			'showPending=true,' +
			'showSkipped=true,' +
			'saveJson=true';
	}

	get hostUrl() {
		this.host = new URL(this.opts.host);
		if (this.opts.host.lastIndexOf(':') < 7) {
			this.host.port = this.opts.port;
		}
		return this.host.origin;
	}

	get reportSrcFolder() {
		return `${this.path}/testReport`;
	}

	get reportDestFolder() {
		return `${this.opts.dataDir}/test-reports/${this.appName}`;
	}

	get reportFile() {
		return `${this.appName}.json`;
	}

	get reportHtml() {
		return `${this.appName}.html`;
	}

	/** @param {CommitDetails} commit */
	async _getDb(commit) {
		const query = {
			app: this.appName,
			commit: commit.hash,
		};
		const projection = {data: 1};
		return this.db.select(query, projection, true);
	}

	/**
	 * @param {CommitDetails} commit
	 * @param {Object} value
	 */
	async _setDb(commit, value) {
		const query = {
			app: this.appName,
			commit: commit.hash,
		};
		const modifier = {$set: {data: value}};
		return this.db.update(query, modifier, true);
	}

	async _getLastGoodCommit() {
		if (this.lastGoodCommit) return this.lastGoodCommit;
		const query = {
			app: this.appName,
			lastGoodCommit: {$exists: true},
		};
		const doc = await this.db.find(query, true);
		if (doc && doc.fromConf === this.app.tests.lastGoodCommit) {
			this.lastGoodCommit = doc.lastGoodCommit;
			return doc.lastGoodCommit;
		}
		await this._setLastGoodCommit(this.app.tests.lastGoodCommit, true);
		this.lastGoodCommit = this.app.tests.lastGoodCommit;
		return this.app.tests.lastGoodCommit;
	}

	async _setLastGoodCommit(commitHash, fromConf = false) {
		const query = {
			app: this.appName,
			lastGoodCommit: {$exists: true},
		};
		const modifier = {
			$set: {lastGoodCommit: commitHash},
		};
		if (fromConf) {
			modifier.$set.fromConf = commitHash;
		}
		await this.db.update(query, modifier, true);
		this.lastGoodCommit = commitHash;
	}

	/**
	 * @typedef {Object} Report
	 * @property {Number} passes
	 * @property {Number} failures
	 * @property {Number} pending
	 * @property {Number} skipped
	 * @property {Number} tests
	 * @property {String} url
	 */

	/**
	 * Get report stats along with Url
	 * @param {CommitDetails} commit
	 * @returns {Report} report object
	 */
	async _getReport(commit) {
		let report;
		try {
			report = await fse.readFile(`${this.reportDestFolder}/${commit.hash}/${this.reportFile}`, 'utf8');
			report = JSON.parse(report).stats;
		}
		catch (e) {
			report = {failures: 1};
		}
		report.url = new URL(`${this.appName}/${commit.hash}`, this.hostUrl).href;
		return report;
	}

	/**
	 * @typedef {Object} TestResults
	 * @property {Boolean} pass
	 * @property {CommitDetails} commit
	 * @property {Error|undefined} err
	 * @property {Report} report
	 */

	/**
	 * Run tests in the TmpDir and copy generated reports to reportDestFolder
	 * @param {Boolean} manualHook Don't use db
	 * @returns {TestResults}
	 */
	async _runTests(manualHook = false, retry = 1) {
		const commit = await this.repo.getHead();

		const fromDb = await this._getDb(commit);
		if (fromDb !== null && !manualHook) {
			return fromDb.data;
		}
		const env = {
			CFG__PORT: await Tester.getFreePort(),
			PATH: process.env.PATH,
			HOME: process.env.HOME,
		};

		if (this.app.tests.privateConfig) {
			await fse.copy(path.join(this.projectCwd, this.app.tests.privateConfig).toString(), `${this.path}/${this.app.tests.privateConfig}`);
		}

		// Run tests
		const err = await spawnAsExec(this.testCommand, {
			cwd: this.path,
			env,
			shell: true,
			// maxBuffer: 500 * 1024,
		}, {
			appName: this.appName,
			commandName: `[${commit.short}] testCommand`,
			debug: this.app.debug,
		});

		// Copy report
		try {
			await fse.ensureDir(`${this.reportDestFolder}/${commit.hash}`);
			await fse.copy(
				`${this.reportSrcFolder}/${this.reportFile}`,
				`${this.reportDestFolder}/${commit.hash}/${this.reportFile}`,
				{overwrite: true}
			);
			await fse.copy(
				`${this.reportSrcFolder}/${this.reportHtml}`,
				`${this.reportDestFolder}/${commit.hash}/${this.reportHtml}`,
				{overwrite: true}
			);
		}
		catch (error) {
			logger.error('[%s] [%s] Can\'t copy report, %s', this.appName, this.commit, error);
		}
		const report = await this._getReport(commit);

		const pass = !(err || report.failures || report.skipped === report.tests);
		if (report.skipped === 0 || retry === 0) {
			if (report.skipped !== 0) logger.error('[%s] [%s] Skipped tests, error: %s', this.appName, this.commit, err);
			await this._setDb(commit, {commit, err, report, pass});
		}
		else if (retry > 0) {
			logger.log(`[${this.appName}] [${this.commit}] Retrying tests on commit ${commit.short} due to ${report.skipped} skipped tests`);
			return this._runTests(manualHook, retry - 1);
		}

		// Checkout repo to remove changes to dist, lock files, etc
		await this.repo.checkout(commit);

		return {
			commit,
			err,
			report,
			pass,
		};
	}

	/**
	 * Run git bisect on the app
	 * @returns {TestResults} Bisect results object
	 */
	async _gitBisect() {
		if (await this._getLastGoodCommit() === (await this.repo.getHead()).hash) {
			// TODO: If current commit is last good commit
			throw new Error(`Lastgoodcommit is same as latest failing commit ${this.commit}`);
		}
		else if (!(await this._getLastGoodCommit())) {
			await this._setLastGoodCommit((await this.repo.getReference('HEAD~10')).hash);
		}

		let res;
		let io;
		let i = 1;
		await this.repo.bisectStart();
		await this.repo.bisect(false);
		await this.repo.checkout(await this._getLastGoodCommit());
		io = await this.repo.bisect(true);

		logger.log('[%s] [%s] Started git bisect', this.appName, this.commit);

		while (/^Bisecting/.test(io.stdout)) {
			const head = await this.repo.getHead();
			logger.log('[%s] [%s] Bisecting step %s, now on commit %s', this.appName, this.commit, i, head.short);

			res = await this._runTests();
			io = await this.repo.bisect(res.pass);
			i++;
		}
		const commit = await this.repo.getCommit(io.stdout.match(/^(\S+)\s.+/)[1]);
		// If last commit tested was not the culprit, checkout and test
		if (res && res.commit.hash !== commit.hash) {
			await this.repo.checkout(commit);
			res = await this._runTests();
		}

		logger.log('[%s] [%s] Bisect complete', this.appName, this.commit);
		return res;
	}


	/**
	 * @typedef {Object} TesterResults
	 * @property {Boolean} pass
	 * @property {CommitDetails} commit Commit on which tests were started
	 * @property {Error} err If tests failed then the error log of tests
	 * @property {Report} report The mochawesome report JSON with added report url
	 * @property {TestResults|undefined} bisect Git Bisect Results
	 */

	/**
	 * Function to run tests for the app, sends results over slack
	 * @param {Object} opts
	 * @param {Boolean} opts.manualHook
	 * @param {Boolean} opts.sendSlack
	 * @returns {TesterResults}
	*/
	async test({manualHook = false, sendSlack = true}) {
		const res = await this._runTests(manualHook);

		// Tests Failed
		if (!res.pass) {
			logger.error('[%s] [%s] Tests failed for app, failures: ', this.appName, this.commit, res.report && res.report.failures);

			let bisect;
			if (!this.manualHead || !manualHook) {
				bisect = await this._gitBisect();
				if (bisect === undefined) res.bisect = res;
				else res.bisect = bisect;
			}
			else logger.log('[%s] [%s] Skipping git Bisect due to manual hook', this.appName, this.commit);
		}
		else if (!this.manualHead && res.report.skipped === 0) {
			logger.log('[%s] [%s] Tests passed for app', this.appName, this.commit);
			await this._setLastGoodCommit(res.commit.hash);
		}
		else {
			logger.log('[%s] [%s] Tests passed but manual head specified or some tests skipped', this.appName, this.commit);
		}

		if (sendSlack) await this.sendSlack(res);
		await this.tmpDir.cleanup();
		return res;
	}

	async sendSlack(res) {
		const attachments = [{
			fallback: `Test report available at ${res.report.url}`,
			title: 'Test Report For:',
			text: `${slack.format.url(res.commit.url, slack.format.code(res.commit.short))} ${res.commit.message} - ${res.commit.author}`,
			fields: [{
				value: `*Passed:* ${res.report.passes}\t` +
					`*Failed:* ${res.report.failures}\t` +
					`*Pending:* ${res.report.pending}\t` +
					`*Skipped:* ${res.report.skipped}`,
			}],
			actions: [{
				type: 'button',
				text: 'Test Report 📋',
				url: res.report.url,
			}],
		}];
		if (this.changes) {
			attachments[0].actions = [{
				type: 'button',
				text: 'Changes 🔍',
				url: this.changes,
			}, ...attachments[0].actions];
		}
		if (!res.pass && res.bisect) {
			attachments.push({
				fallback: `Tests started failing at commit ${res.bisect.commit.short}`,
				title: 'Tests Started Failing At:',
				text: `${slack.format.url(res.bisect.commit.url, slack.format.code(res.bisect.commit.short))} ${res.bisect.commit.message} - ${res.bisect.commit.author}`,
				fields: [{
					value: `*Passed:* ${res.bisect.report.passes}\t` +
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
			});
		}

		if (res.report.passes === undefined) {
			attachments[0].fields[0].value = '*Tests could not be run. No report generated.*';
		}
		else if (res.report.tests === res.report.skipped) {
			attachments[0].fields[0].value = '*Tests timed out!*';
		}
		if (res.bisect.report.passes === undefined) {
			attachments[1].fields[0].value = '*Tests could not be run. No report generated.*';
		}

		let slackSent;
		try {
			if (res.pass) slackSent = await slack.send(`Tests Passed for app *${this.appName}*`, attachments);
			else slackSent = await slack.send(`Tests failed for app *${this.appName}*`, [], attachments);
			logger.log('[%s] [%s] %s', this.appName, this.commit, slackSent);
		}
		catch (e) {
			logger.error('[%s] [%s] Slack Error: %s', this.appName, this.commit, e);
		}
	}


	/**
	 * Function to cleanup the tmp directory
	 * @name Cleanup
	 * @function
	 * @param {Function} [Callback]
	 */

	/**
	 * @typedef {Object} TmpDir
	 * @property {String} path
	 * @property {Cleanup}
	 */

	/**
	 * Create a temporary directory
	 * @returns {TmpDir}
	 */
	static async createTmpDir() {
		return new Promise((resolve, reject) => {
			tmp.dir({unsafeCleanup: true}, (err, dirPath, cleanupCb) => {
				if (err) {
					cleanupCb();
					reject(err);
					return;
				}
				resolve({
					path: dirPath,
					cleanup: async () => {
						await new Promise((res) => {
							cleanupCb(res);
						});
						return fse.remove(dirPath);
					},
				});
			});
		});
	}

	/**
	 * Get free open port to start server on
	 * @returns {Number} Port that is free
	*/
	static async getFreePort() {
		return new Promise((resolve, reject) => {
			let port;
			const server = http.createServer(() => {});
			server.listen();
			server.on('error', async (e) => {
				if (e.code === 'EADDRINUSE') {
					server.close();
					resolve(await Tester.setFreePort());
				}
				else reject(e);
			});
			server.on('listening', () => {
				port = server.address().port;
				server.close();
				resolve(port);
			});
		});
	}
}

module.exports = Tester;
