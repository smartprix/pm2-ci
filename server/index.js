const zlib = require('zlib');
const Koa = require('koa');
const compress = require('koa-compress');
const renderer = require('koa-hbs-renderer');
const auth = require('koa-basic-auth');
const _ = require('lodash');

const hbs = require('../lib/handlebars');
const logger = require('../lib/logger');
const router = require('./router');

const server = new Koa();

server.use(compress({
	threshold: 2048,
	flush: zlib.Z_SYNC_FLUSH,
}));

server.use(renderer(hbs.options));

/**
 *
 * @param {Koa} app
 * @param {import('./Worker.js')} worker
 */
function installRoutes(app, worker) {
	app.use(async (ctx, next) => {
		ctx.worker = worker;
		try {
			await next();
		}
		catch(err) {
			logger.error(`Error in Routes: ${err}\n`, err.stack);
		}
	})
	app.use(router.routes(), router.allowedMethods());
	app.use(async (ctx, next) => {
		if (ctx.method.toLowerCase() === 'post') {
			ctx.body = 'OK';
	
			// get the whole body before processing
			ctx.request.body = '';
			ctx.req.on('data', (data) => {
				ctx.request.body += data;
			}).on('end', () => {
				worker.handleRequest(ctx);
			});
			return;
		}
		await next();
	});	
	app.use(async (ctx) => {
		ctx.status = 404;
		ctx.body = 'N/A';
	});
}

server.on('error', (err => logger.error('[Server] Error: %s', err)));

module.exports = function (req, res) {
	/**
	 * @type {import('./Worker')}
 	 */
	const worker = this;

	if (worker.opts.authPassword) {
		server.use((ctx, next) => {
			if (ctx.method.toLowerCase() !== 'post') {
				return auth({
					name: worker.opts.authName || 'admin',
					pass: worker.opts.authPassword,
				})(ctx, next);
			}
			return next();
		});
	}
	installRoutes(server, worker);
	return server.callback()(req, res);
};
