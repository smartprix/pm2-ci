const {URL} = require('url');
const http = require('http');
const tmp = require('tmp');
const fse = require('fs-extra');
const promisify = require('util').promisify;
const exec = promisify(require('child_process').exec);

const Git = require('./git');
const logger = require('./logger');
const slack = require('./slack');
const {getDb} = require('./db');

/** Class representing a Tester Unit */
class Tester {
	/**
	 * @typedef {Object} VersioningInfo
	 * @property {String} url
	 * @property {String} branch
	 * @property {String} remote 'origin'
	 * @property {String} repo_path
	 * @property {String} head
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
		this.repo = new Git(git);
		this.changes = git.compare;
		return this;
	}

	async init() {
		this.db = await getDb('tests');
		this.tmpDir = await Tester.createTmpDir();
		this.repo = await this.repo.init(this.path);
		return this;
	}

	get path() {
		return this.tmpDir.path;
	}

	get lastGoodCommit() {
		return this.app.tests.lastGoodCommit || '';
	}

	get testCommand() {
		// TODO: Move mochawesome options from application to here
		return `${this.app.tests.testCmd}>/dev/null`;
	}

	get hostUrl() {
		this.host = new URL(this.opts.host);
		if (this.opts.host.lastIndexOf(':') < 7) {
			this.host.port = this.opts.port;
		}
		return this.host.origin;
	}

	get reportSrcFolder() {
		return `${this.path}/${this.app.tests.reportPath.split('/')[0]}`;
	}

	get reportDestFolder() {
		return `${this.opts.logsDir}/test-reports/${this.appName}`;
	}

	get reportFile() {
		return `${this.app.tests.reportPath.split('/')[1]}.json`;
	}

	/** @param {CommitDetails} commit */
	async _getDb(commit) {
		const query = {};
		query[this.appName] = {};
		query[this.appName][commit.hash] = {$exists: true};

		const projection = {};
		projection[`${this.appName}.${commit.hash}`] = 1;
		return this.db.select(query, projection, true);
	}

	/**
	 * @param {CommitDetails} commit
	 * @param {Object} value
	 */
	async _setDb(commit, value) {
		const query = {};
		query[this.appName] = {$exists: true};

		const modifier = {$set: {}};
		modifier.$set[`${this.appName}.${commit.hash}`] = value;
		return this.db.update(query, modifier, true);
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
			report = {};
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
	 * @returns {TestResults}
	 */
	async _runTests() {
		let err;
		const commit = await this.repo.getHead();

		const fromDb = await this._getDb(commit);
		if (fromDb !== null) {
			return fromDb;
		}

		process.env.TEST_PORT = await Tester.getFreePort();
		// TODO: get private config path from git.repo_path (VersioningInfo)
		if (this.app.privateConfig &&
			this.app.privateConfig.src &&
			this.app.privateConfig.dest) {
			await fse.copy(this.app.privateConfig.src, `${this.path}/${this.app.privateConfig.dest}`);
		}
		try {
			await exec(this.testCommand, {
				cwd: this.path,
				env: process.env,
			});
		}
		catch (error) {
			err = error;
		}

		await fse.copy(
			this.reportSrcFolder,
			`${this.reportDestFolder}/${commit.hash}`,
			{overwrite: true}
		);
		const report = await this._getReport(commit);
		const pass = !(err || report.failures);

		if (report.skipped === 0) {
			await this._setDb(commit, {commit, err, report, pass});
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
		if (this.lastGoodCommit === await this.repo.getHead().hash) {
			// TODO: If current commit is last good commit
			throw new Error('Lastgoodcommit is same as latest failing commit');
		}
		else if (!this.lastGoodCommit) {
			// TODO: goodCommit = HEAD~50 or first whichever is recent
			throw new Error(`No lastGoodCommit defined for app ${this.appName}`);
		}

		let res;
		let io;
		let i = 1;
		await this.repo.bisectStart();
		await this.repo.bisect(false);
		await this.repo.checkout(this.lastGoodCommit);
		io = await this.repo.bisect(true);

		logger.log(`Started git bisect for app ${this.appName}`);

		while (/^Bisecting/.test(io.stdout)) {
			const head = await this.repo.getHead();
			logger.log('Bisecting step %s for app %s, commit %s', i, this.appName, head.short);

			res = await this._runTests();
			io = await this.repo.bisect(res.pass);
			i++;
		}
		logger.log('Bisect complete for app %s', this.appName);

		const commit = await this.repo.getCommit(io.stdout.match(/^(\S+)\s.+/)[1]);

		// If last commit tested was not the culprit, checkout and test
		if (res.commit.hash !== commit.hash) {
			await this.repo.checkout(commit);
			res = await this._runTests();
		}
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
	 * Function to run tests for the app, sends results over slack TODO
	 * @returns {TesterResults}
	*/
	async test() {
		const res = await this._runTests();

		// Tests Failed
		if (!res.pass) {
			logger.error(`Tests failed for app ${this.appName} on latest commit, ${await res.commit.short}`);

			res.bisect = await this._gitBisect();
		}
		await this.sendSlack(res);
		await this.tmpDir.cleanup();
		await this.db.compact();
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
		if (!res.pass) {
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
			return slack.send(`Tests failed for app *${this.appName}*`, [], attachments);
		}
		return slack.send(`Tests Passed for app *${this.appName}*`, attachments);
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
			tmp.dir({unsafeCleanup: true}, (err, path, cleanupCb) => {
				if (err) {
					cleanupCb();
					reject(err);
					return;
				}
				logger.log('Created tmp directory', path);
				resolve({
					path,
					cleanup: async () => {
						await new Promise((res) => {
							cleanupCb(res);
						});
						return fse.remove(path);
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
