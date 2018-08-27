const git = require('simple-git/promise');
const Git = require('simple-git');
const {URL} = require('url');
const promisify = require('util').promisify;
const exec = promisify(require('child_process').exec);
const fse = require('fs-extra');
const logger = require('./logger');

class GitExtended {
	/**
	 * Init the Git class
	 * @param {VersioningInfo} options
	 * @returns {GitExtended} A Git Repository object
	 */
	constructor(options) {
		this.opts = options;
		return this;
	}

	/**
	 * Clone the repo and set head and stuff
	 * @param {String} localPath local directory where repo is to be stored
	 */
	async init(localPath) {
		// make remote url
		logger.log('repo dir set to', localPath);
		const url = this.opts.remoteUrl || this.opts.url;
		const match = url.match(/(github.com)[/:](.*)/);

		this.remoteUrl = `https://${this.opts.token}:${'x-oauth-basic'}@${match[1]}/${match[2]}`;
		this.httpsUrl = `https://${match[1]}/${match[2].replace('.git', '')}/`;

		// extract repo name
		// const repoName = this.remoteUrl.match(/\/([A-Za-z-_0-9]+)(?:\.git)?$/)[1];
		// const repoName =  remoteUrlMod.('.git', '').substring(remoteUrlMod.lastIndexOf('/') + 1)

		// repo path
		this.localPath = localPath;

		// branch
		this.branchName = this.opts.branch;
		// pull or clone
		await this.pullOrClone();

		if (this.opts.head) {
			await this.checkout(this.opts.head);
		}
		return this;
	}
	/**
	 * pull all updates of repo
	 * @param {String} localPath local repo path
	 * @param {String} remoteUrl remote url
	 * @param {String} branchName branch name
	 */
	static async _pull(localPath, remoteUrl, branchName) {
		try {
			logger.log('Trying to pull...');
			Git(localPath)
				.addConfig('user.name', 'tester')
				.addConfig('user.email', 'tester@smartprix.com');
			await git(localPath).pull(remoteUrl, branchName);
		}
		catch (error) {
			throw new Error('Pull error:', error);
		}
	}

	/**
	 * Clone repo
	 * @param {String} localPath local repo path
	 * @param {String} remoteUrl remote url
	 * @param {String} branchName branch name
	 */
	static async _clone(localPath, remoteUrl, branchName) {
		try {
			logger.log('Trying to clone...');
			await git().silent(true).clone(remoteUrl, localPath);
			await this._checkOut(localPath, branchName);
		}
		catch (error) {
			throw new Error('Clone error:', error);
		}
	}

	/**
	 * Checkout
	 * @param {String} localPath local repo path
	 * @param {*} what What to checkout(Branch, revision, tag)
	 */
	static async _checkOut(localPath, what, force = true) {
		logger.log('checkout ', what);
		try {
			await git(localPath).checkout([what, force ? '--force' : '']);
		}
		catch (error) {
			throw new Error('Checkout error:', error);
		}
	}
	/**
	 * @typedef {Object} CommitDetails
	 * @property {string} hash	SHA1 hash for commit
	 * @property {string} short	A short hash of commit (length: 7)
	 * @property {string} url Github url to commit
	 * @property {string} message Commit message
	 * @property {string} author Commit author name
	 * @property {Date} time Time of commit as a Date object
	 * @property {string} branch branch name
	 */

	/**
	 * Get commit detail
	 * @param {String} localPath  local repo path
	 * @param {String} commitHash commit hash
	 * @returns {CommitDetails} details of given or latest commit
	 */
	async getCommitDetail(commitHash) {
		try {
			const list = await git(this.localPath).log(commitHash ? [commitHash] : []);
			const commit = list.latest;
			const match = commit.message.match(/(.*)( ?\(HEAD.*\) ?)/);
			return {
				hash: commit.hash,
				short: commit.hash.substr(0, 7),
				url: new URL(`commit/${commit.hash}`, this.httpsUrl).href,
				message: (match && match.length > 1) ? match[1].trim() : commit.message,
				author: commit.author_name,
				time: new Date(commit.date),
				branch: this.branchName || '',
			};
		}
		catch (error) {
			throw new Error('Get commit error:', error);
		}
	}

	/**
	 * pull if repo exists otherwise clone
	 */
	async pullOrClone() {
		const pathExists = await fse.pathExists(this.localPath);
		if (pathExists) {
			try {
				await GitExtended._pull(this.localPath, this.remoteUrl, this.branchName);
			}
			catch (error) {
				await fse.remove(this.localPath);
				await GitExtended._clone(this.localPath, this.remoteUrl, this.branchName);
			}
		}
		else {
			await GitExtended._clone(this.localPath, this.remoteUrl, this.branchName);
		}
	}

	static isValidCommitHash(commitHash) {
		return commitHash.match(/[A-Fa-f0-9]{5,40}/);
	}

	/**
	 * Get HEAD details
	 * @returns {CommitDetails} CommitDetails object of HEAD commit
	 */
	async getHead() {
		if (!this.head) this.head = await this.getCommitDetail();
		return this.head;
	}

	/**
	 * Checkout to commit
	 * @param {CommitDetails|String} commit A CommitDetails object or a commit hash string
	 */
	async checkout(commit) {
		if (typeof commit === 'string' && GitExtended.isValidCommitHash(commit)) {
			commit = await this.getCommitDetail(commit);
		}
		if (typeof commit === 'object' && commit.hash) {
			await GitExtended._checkOut(this.localPath, commit.hash);
			this.head = commit;
		}
		else {
			throw new Error('checkout commit failed: Invalid commit', commit);
		}
	}

	async bisect(pass) {
		if (pass === undefined) throw new Error('Bisect good or bad not defined');
		const io = await exec('git bisect ' + (pass ? 'good' : 'bad'), {
			cwd: this.localPath,
		});
		this.head = await this.getCommitDetail();
		return io;
	}

	async bisectStart() {
		return exec('git bisect start', {cwd: this.localPath});
	}
}

module.exports = GitExtended;
