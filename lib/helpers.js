const spawn = require('child_process').spawn;
const logger = require('./logger');

/**
 * Executes the callback, but in case of success shows a message.
 * Also accepts extra arguments to pass to logger.
 *
 * Example:
 * logCallback(next, '% worked perfect', appName)
 *
 * @param {Function} cb The callback to be called
 * @param {string} message The message to show if success
 * @returns {Function} The callback wrapped
 */
function logCallback(cb, ...args) {
	return function (err) {
		if (err) return cb(err);
		logger.log(...args);
		return cb();
	};
}

/**
 * Wraps the node spawn function to work as exec (line, options, callback).
 * This avoid the maxBuffer issue, as no buffer will be stored.
 *
 * @param {string} command The line to execute
 * @param {string} appName The name of the app
 * @param {object} options The options to pass to spawn
 * @param {function} cb The callback, called with error as first argument
 */
function spawnAsExec(command, appName, options, cb) {
	const child = spawn('eval', [command], options);

	child.on('close', () => {
		cb();
	});

	child.stderr.on('data', (data) => {
		logger.error('[%s] Hook command error : %s', appName, data.toString());
	});

	return child;
}


module.exports = {
	logCallback,
	spawnAsExec,
};
