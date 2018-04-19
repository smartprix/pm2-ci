const spawn = require('child_process').spawn;
const logger = require('./logger');

/**
 * Wraps the node spawn function to work as exec (line, options, callback).
 * This avoid the maxBuffer issue, as no buffer will be stored.
 *
 * @param {string} command The line to execute
 * @param {string} appName The name of the app
 * @param {object} options The options to pass to spawn
 */
async function spawnAsExec(command, appName, options) {
	return new Promise((resolve) => {
		logger.log(command);
		const child = spawn('sh', ['-c', ...command], options);

		child.on('close', () => {
			resolve();
		});

		child.stderr.on('data', (data) => {
			logger.error('[%s] Hook command error : %s', appName, data.toString());
		});

		child.stdout.on('data', (data) => {
			logger.log('[%s] Hook command log : %s', appName, data.toString());
		});
	});
}


module.exports = {
	spawnAsExec,
};
