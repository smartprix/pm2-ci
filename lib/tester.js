const {URL} = require('url');
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
		res: io,
	};
}

async function testRunner({git, opts, appName}) {
	const res = {};
	const app = opts.apps[appName];
	const reportsDir = `${opts.logsDir}/test-reports/${appName}`;
	const tmpDir = await createTmpDir();
	const repo = await cloneRepo(git, tmpDir.path);
	const headCommit = await repo.getHeadCommit();
	const headHash = headCommit.toString();

	const shortHead = headHash.substr(0, 7);
	logger.log(`Running tests, ${app.tests.testCmd}, for app ${appName} on commit ${shortHead}`);

	const testCommand = `${app.prehook} > /dev/null; ${app.tests.testCmd}`;
	const reportSrc = `${tmpDir.path}/${app.tests.reportPath.split('/')[0]}`;
	const tests = await runTests(
		testCommand,
		reportSrc,
		`${reportsDir}/${headHash}`,
		tmpDir.path
	);

	let remoteUrl = (await Git.Remote.lookup(repo, 'origin')).url();
	remoteUrl = remoteUrl.slice(0, remoteUrl.indexOf('.git')) + '/';
	// eslint-disable-next-line
	const report = require(`${tmpDir.path}/${app.tests.reportPath}.json`).stats;
	const reportUrl = (new URL(`${appName}/${headHash}`, opts.host + ':' + opts.port)).href;

	console.log('Report:\n\n', remoteUrl, '\n');
	const slackMsg = [{
		fallback: `Test report available at ${reportUrl}`,
		title: 'Test Report',
		text: '<' + new URL(`commit/${headHash}`, remoteUrl).href + `|\`${shortHead}\`> ${headCommit.message().trim()} - ${headCommit.author()}`,
		fields: [{
			value: `Passed: ${report.passes}, Failed: ${report.failures}, Pending: ${report.pending}`,
			short: true,
		}],
		actions: [{
			type: 'button',
			text: 'Test Report 📋',
			url: reportUrl,
		}],
	}];

	if (tests.code || report.failures) {
		res.pass = false;
		res.err = tests;
		const bisect = await startGitBisect(repo, app.tests.lastGoodCommit, {
			cmd: testCommand,
			reportSrc,
			reportsDir,
			path: tmpDir.path,
		});
		res.commit = bisect.commit.sha();
		logger.log(`Found bad commit for app ${appName}, hash : ${res.commit}`);
		logger.write(`Full Error for app ${appName} on bad commit ${res.commit}: ${JSON.stringify(bisect.tests)}`);
		slackMsg.push({
			fallback: `Tests started failing at commit ${res.commit}`,
			title: 'Tests Started Failing At:',
			text: `<${new URL('commit/' + res.commit, remoteUrl)}|\`${res.commit.substr(0, 7)}\`> ${bisect.commit.message().trim()} - ${bisect.commit.author()}`,
			actions: [{
				type: 'button',
				text: 'View Commit 🔗',
				url: new URL(`commit/${res.commit}`, remoteUrl).href,
			}, {
				type: 'button',
				text: 'Test Report 📋',
				url: (new URL(`${appName}/${res.commit}`, opts.host + ':' + opts.port)).href,
			}],
		});
		slack.send(`Tests failed for app ${appName} at commit ${shortHead}`, [], slackMsg);
	}
	else {
		res.commit = headCommit;
		res.pass = true;
		slack.send(`Tests Passed for app ${appName} at commit ${shortHead}`, slackMsg);
	}
	tmpDir.cleanup();
	return res;
}

module.exports = testRunner;
