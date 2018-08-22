/* eslint-disable class-methods-use-this */
const names = {
	testDb: 'tests',
	appsConfigDb: 'appsConfig',
	appsDir: 'apps',
	repoDir: 'repo',
	coverageDir: 'coverage',
	testDir: 'testReport',
	coverageFile: 'coverage-summary.json',
	coverageHtml: 'index.html',
};
class Vars {
	constructor(dataDir, appName) {
		this.dataDir = dataDir;
		this.appName = appName;
		names.app = appName;
	}

	/**
	 * @returns {String} app directory path
	 */
	get appDir() {
		return `${this.dataDir}/${names.appsDir}/${this.appName}`;
	}

	/**
	 * @returns {String} repo directory path
	 */
	get repoDir() {
		return `${this.appDir}/${names.repoDir}`;
	}

	/**
	 * @returns {String} coverage directory path
	 */
	get coverageDir() {
		return `${this.appDir}/${names.coverageDir}`;
	}

	/**
	 * Get path of commit directory in coverage directory
	 * @param {String} commitHash commit hash
	 * @returns {String} path of commit directory in coverage directory
	 */
	commitCoverageDir(commitHash) {
		return `${this.coverageDir}/${commitHash}`;
	}

	/**
	 * Get commit test directory path
	 * @param {String} commitHash commit hash
	 * @returns {String} commit test directory path
	 */
	commitTestDir(commitHash) {
		return `${this.testDir}/${commitHash}`;
	}

	/**
	 * Get test source directory path
	 * @returns {String} test source directory path
	 */
	get testSrcDir() {
		return `${this.repoDir}/${names.testDir}`;
	}

	/**
	 * Get test destination directory path
	 * @returns {String} test destination directory path
	 */
	get testDestDir() {
		return `${this.appDir}/${names.testDir}`;
	}

	/**
	 * Get commit test destination directory path
	 * @param {String} commitHash commit hash
	 * @returns {String} commit test destination directory path
	 */
	commitTestDestDir(commitHash) {
		return `${this.appDir}/${names.testDir}/${commitHash}`;
	}

	/**
	 * @returns {String} coverage source directory path
	 */
	get covergeSrcDir() {
		return `${this.repoDir}/${names.coverageDir}`;
	}

	/**
	 * @returns {String} coverage destination directory path
	 */
	get coverageDestDir() {
		return `${this.appDir}/${names.coverageDir}`;
	}

	/**
	 * Get commit coverage destination directory path
	 * @param {String} commitHash commit hash
	 * @returns {String} commit coverage destination directory path
	 */
	commitCoverageDestDir(commitHash) {
		return `${this.appDir}/${names.coverageDir}/${commitHash}`;
	}

	/**
	 * Get test source file path
	 * @returns {String} test source file path
	 */
	get testSrcFile() {
		return `${this.testSrcDir}/${this.appName}.json`;
	}

	/**
	 * Get test destination file path
	 * @param {String} commitHash commit hash
	 * @returns {String} test destination file path
	 */
	testDestFile(commitHash) {
		return `${this.commitTestDestDir(commitHash)}/${this.appName}.json`;
	}

	/**
	 * @returns {String} test source html file path
	 */
	get testSrcHtml() {
		return `${this.testSrcDir}/${this.appName}.html`;
	}

	/**
	 * Gettest destination html file path
	 * @param {String} commitHash commit hash
	 * @returns {String}test destination html file path
	 */
	testDestHtml(commitHash) {
		return `${this.commitTestDestDir(commitHash)}/${this.appName}.html`;
	}

	/**
	 * Get coverage source file path
	 * @returns {String} coverage source file path
	 */
	get coverageSrcFile() {
		return `${this.coverageSrcDir}/${names.coverageFile}`;
	}

	/**
	 * Get coverage destination file path
	 * @param {String} commitHash commit hash
	 * @returns {String} coverage destination file path
	 */
	coverageDestFile(commitHash) {
		return `${this.commitCoverageDestDir(commitHash)}/${names.coverageFile}`;
	}

	/**
	 * Get test relative url
	 * @param {String} commitHash commit hash
	 * @returns {String} test relative url
	 */
	testUrl(commitHash) {
		return `${this.appName}/${commitHash}`;
	}

	/**
	 * Get coverage relative url
	 * @param {String} commitHash commit hash
	 * @returns {String} coverage relative url
	 */
	coverageUrl(commitHash) {
		return `${this.testUrl(commitHash)}/${names.coverageDir}/${names.coverageHtml}`;
	}

	/**
	 * Get private config absolute path
	 * @param {String} privateConfig private config path relative to repository
	 * @returns {String} {String} private config absolute path
	 */
	privateConfigSrc(privateConfig) {
		return `${this.repoDir}/${privateConfig}`;
	}

	/**
	 * Get private config absolute path
	 * @param {String} privateConfig private config path relative to repository
	 * @returns {String} {String} private config absolute path
	 */
	privateConfigDest(privateConfig) {
		return `${this.repoDir}/${privateConfig}`;
	}
}

module.exports = {
	Vars,
	names,
};
