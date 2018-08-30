const spawn = require('child_process').spawn;
const logger = require('./logger');

/**
 * Wraps the node spawn function to work as exec (line, options, callback).
 * This avoid the maxBuffer issue, as no buffer will be stored.
 *
 * @param {string} command The line to execute
 * @param {object} spawnOptions The options to pass to spawn
 * @param {object} opts The options for logs
 * @param {string} opts.appName The name of the app
 * @param {string} opts.commandName The name of the command
 * @param {boolean} opts.debug if stdout of command need to be output
 */
async function spawnAsExec(command, spawnOptions, {appName, commandName, debug}) {
	return new Promise((resolve, reject) => {
		const stdio = {stderr: '', stdout: ''};
		const child = spawn('eval', [command], spawnOptions);

		child.on('close', (code) => {
			if (code === 0) resolve(stdio);
			else reject(stdio);
		});

		child.stderr.on('data', (data) => {
			stdio.stderr += data.toString();
			if (debug) {
				logger.error('[%s] %s error : %s', appName, commandName, data.toString());
			}
		});

		child.stdout.on('data', (data) => {
			if (debug) {
				stdio.stdout += data.toString();
				logger.log('[%s] %s log : %s', appName, commandName, data.toString());
			}
		});
	});
}


module.exports = {
	spawnAsExec,
};
