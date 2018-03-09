const {URL} = require('url');
const tmp = require('tmp');
const Git = require('nodegit');
const fse = require('fs-extra');
const promisify = require('util').promisify;
const exec = promisify(require('child_process').exec);

const logger = require('./logger');
const slack = require('./slack');

/** Class representing a Tester Unit */
class Tester {
	/**
	 * @typedef {Object} VersioningInfo
	 * @property {String} url
	 * @property {String} branch
	 */

	/**
	 * Constructor
	 * @param {VersioningInfo} git
	 * @param {Object} opts The pm2 config object for the module
	 * @param {String} appName
	 */
	constructor(git, opts, appName) {
		this.git = git;
		this.opts = opts;
		this.appName = appName;
		this.app = opts.apps[appName];
		return this;
	}

	get path() {
		return this.tmpDir.path;
	}

	get lastGoodCommit() {
		return this.app.tests.lastGoodCommit;
	}

	get testCommand() {
		return `${this.app.prehook} > /dev/null; ${this.app.tests.testCmd}`;
	}

	get hostUrl() {
		this.host = new URL(this.opts.host);
		if (this.opts.host.lastIndexOf(':') < 7) {
			this.host.port = this.opts.port;
		}
		return this.host.origin;
	}

	get remoteUrl() {
		return this.remote.url().slice(0, this.remote.url().indexOf('.git')) + '/';
	}

	get reportSrcFolder() {
		return `${this.path}/${this.app.tests.reportPath.split('/')[0]}`;
	}

	get reportPath() {
		return `${this.path}/${this.app.tests.reportPath}.json`;
	}

	get reportDestFolder() {
		return `${this.opts.logsDir}/test-reports/${this.appName}`;
	}

	async init() {
		this.tmpDir = await Tester.createTmpDir();

		// Git repo initialization
		this.repo = await Tester.cloneRepo(this.git, this.path);
		this.remote = await Git.Remote.lookup(this.repo, 'origin');
		const head = await this.repo.getHeadCommit();
		this.head = await this.getCommitDetails(head);
		return this;
	}

	/**
	 * @typedef {Object} CommitDetails
	 * @property {Commit} commit nodegit object
	 * @property {string} hash	SHA1 hash for commit
	 * @property {string} short	A short hash of commit (length: 7)
	 * @property {string} url Github url to commit
	 * @property {string} message Commit message
	 * @property {string} author Commit author name
	 * @property {string} report Url to the report for this commit (might not be valid)
	 */

	/**
	 * Get Commit details from nodegit
	 * @param {Commit|String} commit A nodegit Commit object or a commit hash string
	 * @returns {CommitDetails}
	 */
	async getCommitDetails(commit) {
		if (typeof commit === 'string' || commit instanceof String) {
			commit = await Git.Commit.lookup(this.repo, commit);
		}
		return {
			commit,
			hash: commit.toString(),
			short: commit.toString().substr(0, 7),
			url: new URL(`commit/${commit.toString()}`, this.remoteUrl).href,
			message: commit.message().trim(),
			author: commit.author().toString().slice(0, commit.author().toString().indexOf('<')).trim(),
			report: new URL(`${this.appName}/${commit.toString()}`, this.hostUrl).href,
		};
	}

	/**
	 * Run tests in the TmpDir and copy generated reports to reportDestFolder
	 * @param {Commit|String} commit A nodegit commit object or commit hash
	 * @returns {Object} If passed then {stdout, stderr}, if failed then the Error object
	 */
	async _runTests(commit) {
		let tests;
		try {
			tests = await exec(this.testCommand, {cwd: this.path});
		}
		catch (error) {
			tests = error;
		}
		await fse.copy(
			this.reportSrcFolder,
			`${this.reportDestFolder}/${commit.toString()}`,
			{overwrite: true}
		);
		return tests;
	}

	async _getReport() {
		// eslint-disable-next-line
		const report = require(this.reportPath).stats;
		report.url = new URL(`${this.appName}/${this.head.hash}`, this.hostUrl).href;
		return report;
	}

	sendSlack(res) {
		const attachments = [{
			fallback: `Test report available at ${this.report.url}`,
			title: 'Test Report For:',
			text: `${slack.format.url(this.head.url, slack.format.code(this.head.short))} ${this.head.message} - ${this.head.author}`,
			fields: [{
				value: `*Passed:* ${this.report.passes}, ` +
					`*Failed:* ${this.report.failures}, ` +
					`*Pending:* ${this.report.pending}`,
				short: true,
			}],
			actions: [{
				type: 'button',
				text: 'Test Report 📋',
				url: this.report.url,
			}],
		}];
		if (!res.pass) {
			attachments.push({
				fallback: `Tests started failing at commit ${res.commit.short}`,
				title: 'Tests Started Failing At:',
				text: `${slack.format.url(res.commit.url, slack.format.code(res.commit.short))} ${res.commit.message} - ${res.commit.author}`,
				actions: [{
					type: 'button',
					text: 'View Commit 🔗',
					url: res.commit.url,
				}, {
					type: 'button',
					text: 'Test Report 📋',
					url: res.commit.report,
				}],
			});
			slack.send(`Tests failed for app *${this.appName}*`, [], attachments);
			return;
		}
		slack.send(`Tests Passed for app *${this.appName}*`, attachments);
	}

	async gitBisect() {
		const opts = {cwd: this.path};
		await exec('git bisect start', opts);
		await exec('git bisect bad', opts);

		let good;
		if (this.lastGoodCommit) {
			good = await this.getCommitDetails(this.lastGoodCommit);
		}
		else {
			logger.error('No lastGoodCommit defined for app ', this.appName);
			return {
				commit: {},
			};
			// TODO: goodCommit = HEAD~50 or first whichever is recent
		}
		await Git.Checkout.tree(this.repo, good.commit, {
			checkoutStrategy: Git.Checkout.STRATEGY.FORCE,
		});
		await this.repo.setHeadDetached(good.commit.id());

		// Starts git bisect
		let tests;
		let io = await exec('git bisect good', opts);
		logger.log(`Started git bisect for app ${this.appName}`);

		while (/^Bisecting/.test(io.stdout)) {
			const commit = io.stdout.match(/\[(.+)\]/)[1];
			tests = await this._runTests(commit);

			if (tests.code) io = await exec('git bisect bad', opts);
			else io = await exec('git bisect good', opts);
		}
		return {
			commit: await this.getCommitDetails(io.stdout.match(/(\S+)\s.+/)[1]),
			tests,
			res: io,
		};
	}

	async test() {
		let res = {
			commit: this.head,
			pass: true,
		};
		this.result = await this._runTests(this.head.hash);
		this.report = await this._getReport();

		// Tests Failed
		if (this.result.code || this.report.failures) {
			const bisect = await this.gitBisect();
			res = {
				pass: false,
				err: this.result,
				commit: bisect.commit,
			};
			logger.log(`Found bad commit for app ${this.appName}, hash : ${res.commit.short}`);
			logger.write(`Full Error for app ${this.appName} on bad commit ${res.commit.short}: ${JSON.stringify(bisect.tests)}`);
		}
		this.sendSlack(res);
		this.tmpDir.cleanup();
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
	static async createTmpDir() {
		return new Promise((resolve, reject) => {
			tmp.dir({unsafeCleanup: true}, (err, path, cleanupCb) => {
				if (err) {
					cleanupCb();
					reject(err);
					return;
				}
				resolve({path, cleanup: cleanupCb});
			});
		});
	}

	/**
	 * Clones repository according to the given Git options to the specified path
	 * @param {VersioningInfo} git
	 * @param {String} path
	 * @returns {Repository} A nodegit Repository object
	 */
	static async cloneRepo(git, path) {
		return Git.Clone(git.url, path, {
			checkoutBranch: git.branch,
			fetchOpts: {
				callbacks: {
					credentials(url, userName) {
						return Git.Cred.sshKeyFromAgent(userName);
					},
					certificateCheck() {
						return 1;
					},
				},
			},
		});
	}
}

module.exports = Tester;
