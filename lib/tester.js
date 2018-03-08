const {URL} = require('url');
const tmp = require('tmp');
const Git = require('nodegit');
const fse = require('fs-extra');
const promisify = require('util').promisify;
const exec = promisify(require('child_process').exec);

const logger = require('./logger');
const slack = require('./slack');

class Tester {
	constructor(git, opts, appName) {
		this.git = git;
		this.opts = opts;
		this.appName = appName;
		this.app = opts.apps[appName];
		return this;
	}

	async _initGitStuff() {
		this.repo = await Tester.cloneRepo(this.git, this.tmpDir.path);
		this.remote = await Git.Remote.lookup(this.repo, 'origin');
		this.remoteUrl = this.remote.url().slice(0, this.remote.url().indexOf('.git')) + '/';

		const head = await this.repo.getHeadCommit();
		this.head = await this.getCommitDetails(head);
	}

	async init() {
		this.testCommand = `${this.app.prehook} > /dev/null; ${this.app.tests.testCmd}`;
		this.tmpDir = await Tester.createTmpDir();
		this.reportSrc = `${this.tmpDir.path}/${this.app.tests.reportPath.split('/')[0]}`;
		this.host = new URL(this.opts.host);
		if (this.opts.host.lastIndexOf(':') < 7) {
			this.host.port = this.opts.port;
		}
		this.hostUrl = this.host.origin;
		await this._initGitStuff();
		return this;
	}

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

	async _runTests(commit) {
		let tests;
		try {
			tests = await exec(this.testCommand, {cwd: this.tmpDir.path});
		}
		catch (error) {
			tests = error;
		}
		await fse.copy(
			this.reportSrc,
			`${this.opts.logsDir}/test-reports/${this.appName}/${commit}`,
			{overwrite: true}
		);
		return tests;
	}

	async _getReport() {
		// eslint-disable-next-line
		const report = require(`${this.tmpDir.path}/${this.app.tests.reportPath}.json`).stats;
		report.url = new URL(`${this.appName}/${this.head.hash}`, this.hostUrl).href;
		return report;
	}

	_buildSlackMsg(badCommit = false) {
		const attachments = [{
			fallback: `Test report available at ${this.report.url}`,
			title: 'Test Report For:',
			text: `${slack.format.url(this.head.url, `\`${this.head.short}\``)} ${this.head.message} - ${this.head.author}`,
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
		if (badCommit) {
			attachments.push({
				fallback: `Tests started failing at commit ${badCommit.short}`,
				title: 'Tests Started Failing At:',
				text: `${slack.format.url(badCommit.url, `\`${badCommit.short}\``)} ${badCommit.message} - ${badCommit.author}`,
				actions: [{
					type: 'button',
					text: 'View Commit 🔗',
					url: badCommit.url,
				}, {
					type: 'button',
					text: 'Test Report 📋',
					url: badCommit.report,
				}],
			});
		}
		return attachments;
	}

	async gitBisect() {
		const opts = {cwd: this.tmpDir.path};
		await exec('git bisect start', opts);
		await exec('git bisect bad', opts);

		let good;
		if (this.app.tests.lastGoodCommit) {
			good = await this.getCommitDetails(this.app.tests.lastGoodCommit);
		}
		else {
			// TODO: goodCommit =
		}
		// Checkout to Good Commit
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
		const res = {};
		this.result = await this._runTests(this.head.hash);
		this.report = await this._getReport();

		// Tests Failed
		if (this.result.code || this.report.failures) {
			res.pass = false;
			res.err = this.result;
			const bisect = await this.gitBisect();
			res.commit = bisect.commit.short;
			logger.log(`Found bad commit for app ${this.appName}, hash : ${res.commit}`);
			logger.write(`Full Error for app ${this.appName} on bad commit ${res.commit}: ${JSON.stringify(bisect.tests)}`);
			slack.send(`Tests failed for app *${this.appName}*`, [], this._buildSlackMsg(bisect.commit));
		}
		else {
			res.commit = this.head;
			res.pass = true;
			slack.send(`Tests Passed for app *${this.appName}*`, this._buildSlackMsg());
		}
		this.tmpDir.cleanup();
		return res;
	}


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
