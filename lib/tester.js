const tmp = require('tmp');
const Git = require('nodegit');
const fse = require('fs-extra');
const promisify = require('util').promisify;
const exec = promisify(require('child_process').exec);

const logger = require('./logger');
const slack = require('./slack');

async function createTmpDir() {
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

async function cloneRepo(git, path) {
	const gitOpts = {
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
	};
	return Git.Clone(git.url, path, gitOpts);
}

async function runTests(command, reportSrc, reportDest, cwd) {
	let tests;
	try {
		tests = await exec(command, {cwd});
	}
	catch (error) {
		tests = error;
	}
	await fse.copy(
		reportSrc,
		reportDest,
		{overwrite: true}
	);

	return tests;
}

async function startGitBisect(repo, lastGoodCommit, testOpts) {
	const cwd = testOpts.path;
	await exec('git bisect start', {cwd});
	await exec('git bisect bad', {cwd});

	let goodCommit;
	if (lastGoodCommit) {
		goodCommit = await Git.Commit.lookup(repo, lastGoodCommit);
	}
	else {
		// goodCommit =
	}
	// Checkout to Good Commit
	await Git.Checkout.tree(repo, goodCommit, {
		checkoutStrategy: Git.Checkout.STRATEGY.FORCE,
	});
	await repo.setHeadDetached(goodCommit.id());

	// Starts git bisect
	let tests;
	let io = await exec('git bisect good', {cwd});
	logger.log('Started git bisect');

	while (/^Bisecting/.test(io.stdout)) {
		const commit = io.stdout.match(/\[(.+)\]/)[1];
		tests = await runTests(
			testOpts.cmd,
			testOpts.reportSrc,
			`${testOpts.reportsDir}/${commit}`,
			testOpts.path,
		);
		if (tests.code) {
			io = await exec('git bisect bad', {cwd});
		}
		else {
			io = await exec('git bisect good', {cwd});
		}
	}
	return {
		commit: await Git.Commit.lookup(repo, io.stdout.match(/(\S+)\s.+/)[1]),
		tests,
	};
}

async function testRunner({git, app, appName, reportsDir}) {
	const res = {};
	const tmpDir = await createTmpDir();
	const repo = await cloneRepo(git, tmpDir.path);
	const headCommit = (await repo.getHeadCommit()).toString();

	const shortHead = headCommit.substr(0, 7);
	logger.log(`Running tests, ${app.tests.testCmd}, for app ${appName} on commit ${shortHead}`);

	const testCommand = `${app.prehook} > /dev/null; ${app.tests.testCmd}`;
	const reportSrc = `${tmpDir.path}/${app.tests.reportPath.split('/')[0]}`;
	const tests = await runTests(
		testCommand,
		reportSrc,
		`${reportsDir}/${headCommit}`,
		tmpDir.path
	);

	// eslint-disable-next-line
	const report = require(`${tmpDir.path}/${app.tests.reportPath}.json`).stats;

	if (tests.code || report.failures) {
		res.pass = false;
		logger.error(`Tests failed for app ${appName} on commit ${shortHead}, \nError Code: ${tests.code} (full error in file logs)`);
		logger.write(`Full Error: ${JSON.stringify(tests)}`);
		const bisect = await startGitBisect(repo, app.tests.lastGoodCommit, {
			cmd: testCommand,
			reportSrc,
			reportsDir,
			path: tmpDir.path,
		});
		res.err = bisect.tests;
		res.commit = bisect.commit.sha();
		logger.log(`Found bad commit for app ${appName}, hash : ${res.commit}`);
	}
	else {
		res.commit = headCommit;
		res.pass = true;
		logger.log(`All tests passed for app ${appName} on commit ${shortHead}`);
	}

	tmpDir.cleanup(() => { logger.log('Cleaned up tmp dir') });
	slack.send('success');
	return res;
}

module.exports = testRunner;
