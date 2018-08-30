const {URL} = require('url');
const path = require('path');
const http = require('http');
const fse = require('fs-extra');
const _ = require('lodash');

const Git = require('./git');
const logger = require('./logger');
const db = require('./db');
const {spawnAsExec} = require('./helpers');
const {Vars, names} = require('./common');

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
		this.vars = new Vars(opts.dataDir, appName);
		return this;
	}

	async init() {
		this.db = await db.getTestsDb();
		this.repo = await this.repo.init(this.vars.repoDir);
		this.commit = (await this.repo.getHead()).short;
		logger.log('[%s] [%s] Initialized and cloned. Repo directory: %s', this.appName, this.commit, this.vars.repoDir);
		return this;
	}

	get changes() { return this.git.compare }

	get manualHead() { return this.git.head }

	get projectCwd() { return this.app.cwd || this.git.repo_path }

	get testCommand() {
		return `${this.app.tests.testCmd} -- --reporter mochawesome --reporter-options ` +
			`reportDir=${names.testDir},` +
			`reportFilename=${this.appName},` +
			`reportPageTitle='Report for ${this.appName} on commit ${(this.repo.head ? this.repo.head.short : '')}',` +
			`reportTitle='Report for ${this.appName} on commit ${(this.repo.head ? this.repo.head.short : '')}',` +
			'cdn=true,' +
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

	/** @param {String} commitHash */
	async _getDb(commitHash) {
		const query = {
			app: this.appName,
			commit: commitHash,
		};
		const projection = {data: 1};
		return this.db.select(query, projection, true);
	}

	/**
	 * @param {String} commitHash
	 * @param {Object} value
	 */
	async _setDb(commitHash, value) {
		const query = {
			app: this.appName,
			commit: commitHash,
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
	 * @typedef {Object} TestReport
	 * @property {Number} passes
	 * @property {Number} failures
	 * @property {Number} pending
	 * @property {Number} skipped
	 * @property {Number} tests
	 * @property {String} url
	 */

	/**
	 * Get report stats along with Url
	 * @param {String} commitHash
	 * @returns {TestReport} test report object
	 */
	async _getTest(commitHash) {
		let report;
		try {
			report = await fse.readFile(this.vars.testSrcFile, 'utf8');
			report = JSON.parse(report).stats;
			report.url = new URL(this.vars.testUrl(commitHash), this.hostUrl).href;
		}
		catch (e) {
			// console.log('Get test error:', e);
			report = {failures: 1};
		}
		return report;
	}
	/**
	 * @typedef {Object} CoverageDetails
	 * @property {Number} total
	 * @property {Number} covered
	 * @property {Number} skipped
	 * @property {Number} pct
	 * @property {String|undefined} url
	 */

	/**
	 * @typedef {Object} CoverageReport
	 * @property {CoverageDetails} lines
	 * @property {CoverageDetails} functions
 	 * @property {CoverageDetails} statements
 	 * @property {CoverageDetails} branches
	 * @property {String} url
	 */
	/**
	 * Get total coverage report stats along with Url
	 * @param {String} commitHash
	 * @returns {CoverageReport} coverage report object
	 *
	*/
	async _getCoverage(commitHash) {
		let coverage;
		try {
			coverage = await fse.readFile(this.vars.coverageSrcFile, 'utf8');
			coverage = JSON.parse(coverage).total;
			coverage.url = new URL(this.vars.coverageUrl(commitHash), this.hostUrl).href;
		}
		catch (e) {
			coverage = {lines: {}};
		}
		return coverage;
	}
	/**
	 * @typedef {Object} TestResults
	 * @property {Boolean} pass
	 * @property {CommitDetails} commit
	 * @property {Error|undefined} err
	 * @property {Report} report
	 * @property {CoverageDetails} coverage
	 */

	/**
	 * Run tests in the TmpDir and copy generated reports to testDestFolder
	 * @param {Boolean} manualHook Don't use db
	 * @returns {TestResults}
	 */
	async _runTests(manualHook = false, retry = 1) {
		let err;
		const commit = await this.repo.getHead();

		const fromDb = await this._getDb(commit.hash);
		if (fromDb !== null && !manualHook) {
			return fromDb.data;
		}
		const env = {
			CFG__PORT: await Tester.getFreePort(),
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			..._.pickBy(process.env, (val, key) => key.indexOf('CFG__') === 0),
		};

		if (this.app.tests.privateConfig) {
			await fse.copy(path.join(this.projectCwd, this.app.tests.privateConfig).toString(),
				this.vars.privateConfigDest(this.app.tests.privateConfig));
		}

		try {
			await fse.remove(this.vars.testSrcDir);
			await fse.remove(this.vars.coverageSrcDir);
			if (retry === 0) await fse.remove(`${this.vars.repoDir}/node_modules`);
		}
		catch(er) {
			// 
		}

		// Run tests
		try {
			await spawnAsExec(this.testCommand, {
				cwd: this.vars.repoDir,
				env,
				shell: true,
			// maxBuffer: 500 * 1024,
			}, {
				appName: this.appName,
				commandName: `[${commit.short}] testCommand`,
				debug: this.app.debug,
			});
		}
		catch (error) {
			err = error;
		}

		// Copy report
		try {
			await fse.ensureDir(this.vars.commitTestDestDir(commit.hash));
			await fse.copy(
				this.vars.testSrcFile,
				this.vars.testDestFile(commit.hash),
				{overwrite: true}
			);
			await fse.copy(
				this.vars.testSrcHtml,
				this.vars.testDestHtml(commit.hash),
				{overwrite: true}
			);

			await fse.ensureDir(this.vars.commitCoverageDestDir(commit.hash));
			await fse.copy(
				this.vars.coverageSrcDir,
				this.vars.commitCoverageDestDir(commit.hash),
				{overwrite: true}
			);
		}
		catch (error) {
			logger.error('[%s] [%s] Can\'t copy report, %s', this.appName, this.commit, error);
		}
		const report = await this._getTest(commit.hash);
		const totalCoverage = await this._getCoverage(commit.hash);
		const lineCoverage = totalCoverage.lines;
		lineCoverage.url = totalCoverage.url;
		const pass = !(report.failures || report.skipped);
		if (report.skipped === 0 || retry === 0) {
			if (report.skipped !== 0) logger.error('[%s] [%s] Skipped tests, error: %s', this.appName, this.commit, err);
			await this._setDb(commit.hash, {
				commit, err, report, pass, coverage: lineCoverage,
			});
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
			coverage: lineCoverage,
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
			throw new Error('No lastgoodcommit defined');
			// await this._setLastGoodCommit((await this.repo.getReference('HEAD~10')).hash);
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
		const commit = await this.repo.getCommitDetail(io.stdout.match(/^(\S+)\s.+/)[1]);
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
	 * @returns {TesterResults}
	*/
	async test({manualHook = false}) {
		const res = await this._runTests(manualHook);

		// Tests Failed
		if (!res.pass) {
			logger.error('[%s] [%s] Tests failed for app, failures: ', this.appName, this.commit, res.report && res.report.failures);

			let bisect;
			if ((!this.manualHead || !manualHook) && (this.app.bisect || this.app.bisect === undefined)) {
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
		return res;
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
	// static async createTmpDir() {
	// 	return new Promise((resolve, reject) => {
	// 		tmp.dir({unsafeCleanup: true}, (err, this.vars.appDirPath, cleanupCb) => {
	// 			if (err) {
	// 				cleanupCb();
	// 				reject(err);
	// 				return;
	// 			}
	// 			resolve({
	// 				path: this.vars.appDirPath,
	// 				cleanup: async () => {
	// 					await new Promise((res) => {
	// 						cleanupCb(res);
	// 					});
	// 					return fse.remove(this.vars.appDirPath);
	// 				},
	// 			});
	// 		});
	// 	});
	// }

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
