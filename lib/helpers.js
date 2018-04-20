const spawn = require('child_process').spawn;
const logger = require('./logger');

/**
 * Wraps the node spawn function to work as exec (line, options, callback).
 * This avoid the maxBuffer issue, as no buffer will be stored.
 *
 * @param {string} command The line to execute
 * @param {object} options The options to pass to spawn
 * @param {string} appName The name of the app
 */
async function spawnAsExec(command, options, appName, commanName) {
	return new Promise((resolve) => {
		logger.log(command);
		const child = spawn('eval', [command], options);

		child.on('close', () => {
			resolve();
		});

		child.stderr.on('data', (data) => {
			logger.error('[%s] %s error : %s', appName, commanName, data.toString());
		});

		child.stdout.on('data', (data) => {
			logger.log('[%s] %s log : %s', appName, commanName, data.toString());
		});
	});
}


module.exports = {
	spawnAsExec,
};
