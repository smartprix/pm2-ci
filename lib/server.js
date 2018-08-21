const zlib = require('zlib');
const path = require('path');
const Koa = require('koa');
const staticCache = require('koa-static-cache');
const compress = require('koa-compress');
const renderer = require('koa-hbs-renderer');
const auth = require('koa-basic-auth');
const _ = require('lodash');
const send = require('koa-send');

const db = require('./db');
const hbs = require('./handlebars');
const logger = require('./logger');

const server = new Koa();

server.use(compress({
	threshold: 2048,
	flush: zlib.Z_SYNC_FLUSH,
}));

server.use(staticCache(path.join(__dirname, './../templates/assets'), {
	maxAge: 30 * 24 * 60 * 60,			// 1 year (max-age in seconds)
	preload: false,						// don't cache file at start
	prefix: '/assets',					// path to serve at
	dynamic: true,						// load extra files if they exist
}));

server.use(renderer(hbs.options));

/**
 *
 * @param {Koa} app
 * @param {import('./Worker.js')} worker
 */
function installRoutes(app, worker) {
// Basic parser
	app.use(async (ctx, next) => {
		try {
			if (ctx.request.method === 'GET') ctx.state.get = true;
			else if (ctx.request.method === 'POST') ctx.state.post = true;
			const urlPath = ctx.request.URL.pathname ? ctx.request.URL.pathname.split('/') : [];

			ctx.state.apps = Object.keys(worker.apps);
			ctx.state.appName = urlPath.length > 1 ? urlPath[1] : undefined;
			ctx.state.app = worker.apps[ctx.state.appName];
			if (urlPath.length >= 3 && /[a-f0-9]{40}/.test(urlPath[2])) {
				ctx.state.commit = urlPath[2];
				if (urlPath.length >= 4 && urlPath[3] === 'coverage') {
					ctx.state.reportDir = 'coverage';
					ctx.state.reportFile = urlPath.slice(4).join('/');
				}
				else {
					ctx.state.reportDir = 'testReport';
					ctx.state.reportFile = `${ctx.state.appName}.html`;
				}
			}
			else {
				ctx.state.action = urlPath[2];
			}
			await next();
		}
		catch (e) { logger.error('[Server] Error: %s', e) }
	});

	// Serve reports
	app.use(async (ctx, next) => {
		if (ctx.state.get &&
		ctx.state.app &&
		ctx.state.commit &&
		ctx.state.reportDir
		) {
			const filePath = `${worker.opts.dataDir}/apps/${ctx.state.appName}/` +
			`${ctx.state.reportDir}/${ctx.state.commit}/${ctx.state.reportFile}`;
			ctx.set('Content-type', 'text/' + ctx.state.reportFile.split('.')[1]);
			try {
				await send(ctx, filePath);
			}
			catch (e) {
				ctx.status = 404;
				ctx.state.msg = `Commit, ${ctx.state.commit}, report not found!`;
				await ctx.render('testListing', ctx.state);
			}
			return;
		}
		await next();
	});

	// Manually start hook
	app.use(async (ctx, next) => {
		if (ctx.state.get &&
		ctx.state.appName &&
		ctx.query.secret &&
		ctx.state.action === 'hook'
		) {
			if (ctx.state.app && ctx.query.secret === ctx.state.app.secret) {
				worker.handleRequest(ctx, true, (ctx.query.deploy === 'on' && !ctx.query.commit));
				ctx.state.msg = `Started Hook for ${ctx.state.appName}, for commit ${ctx.query.commit || 'LATEST'}`;
			}
			else if (!ctx.state.app) {
				ctx.state.msg = `App ${ctx.state.appName} doesn't exist in config`;
			}
			else ctx.state.msg = 'Wrong Secret';
			await ctx.render('testListing', ctx.state);
			return;
		}
		await next();
	});

	// Add App
	app.use(async (ctx, next) => {
		if (ctx.state.get &&
		ctx.state.action === 'add'
		) {
			if (ctx.state.app) {
				ctx.state.msg = `App ${ctx.state.appName} already exists in config`;
			}
			else if (ctx.query.appName && ctx.query.secret) {
				const appConfig = _.pick(ctx.query, ['appName', 'secret', 'prehook', 'posthook', 'cwd']);
				appConfig.debug = ctx.query.debug === 'on';
				appConfig.bisect = ctx.query.bisect === 'on';

				appConfig.tests = _.pick(ctx.query, ['privateConfig', 'testCmd', 'lastGoodCommit', 'githubToken']);
				appConfig.tests.deployAnyway = ctx.query.deployAnyway === 'on';

				await worker.upsertAppConfig(ctx.query.appName, appConfig);
				ctx.redirect(`/${ctx.query.appName}`);
				return;
			}
			else {
				ctx.state.msg = 'App Name and Secret are required';
			}
			await ctx.render('appListing', ctx.state);
			return;
		}
		await next();
	});

	// Edit App
	app.use(async (ctx, next) => {
		if (ctx.state.get &&
		ctx.state.app &&
		ctx.state.action === 'edit'
		) {
			const oldConfig = worker.apps[ctx.state.appName];
			let conflictingConfig;
			if (ctx.query.appName !== ctx.state.appName) {
				conflictingConfig = worker.apps[ctx.query.appName];
			}
			if (conflictingConfig) {
				ctx.state.msg = 'New name conflicts with existing app config';
			}
			else if (ctx.query.oldSecret === oldConfig.secret) { // check secret
				const appConfig = _.pick(ctx.query, ['appName', 'secret', 'prehook', 'posthook', 'cwd']);
				appConfig.debug = ctx.query.debug === 'on';
				appConfig.bisect = ctx.query.bisect === 'on';

				appConfig.tests = _.pick(ctx.query, ['privateConfig', 'testCmd', 'lastGoodCommit', 'githubToken']);
				appConfig.tests.deployAnyway = ctx.query.deployAnyway === 'on';

				appConfig.secret = appConfig.secret || oldConfig.secret;
				// update
				const res = await worker.upsertAppConfig(ctx.state.appName, appConfig);
				if (ctx.query.appName !== ctx.state.appName) {
					ctx.redirect(`/${ctx.query.appName}`);
					return;
				}
				ctx.state.app = res;
			}
			else ctx.state.msg = 'Wrong Secret';
			await ctx.render('testListing', ctx.state);
			return;
		}
		await next();
	});

	// Serve directory listing
	app.use(async (ctx, next) => {
		if (ctx.state.get &&
		!ctx.state.commit
		) {
			if (!ctx.state.appName) {
				await ctx.render('appListing', ctx.state);
			}
			else if (ctx.state.app) {
				const testsDb = await db.getTestsDb();
				const perPage = 15;
				ctx.state.page = ctx.query.page ? Math.max(Number.parseInt(ctx.query.page, 10), 1) : 1;
				if (ctx.state.page > 1) ctx.state.prevPage = ctx.state.page - 1;
				ctx.state.nextPage = ctx.state.page + 1;

				const data = await new Promise((resolve, reject) => {
					testsDb.db
						.find({app: ctx.state.appName, commit: {$exists: true}, data: {$exists: true}})
						.sort({'data.commit.time': -1})
						.skip((ctx.state.page - 1) * perPage)
						.limit(perPage)
						.exec((err, docs) => {
							if (err) reject(err);
							else resolve(docs);
						});
				});
				ctx.state.db = data;

				const appsConfigDb = await db.getAppsConfigDb();
				ctx.state.app = await appsConfigDb.find({appName: ctx.state.appName}, true);
				if (!Array.isArray(data)) ctx.state.msg = 'Nothing Here.';
				await ctx.render('testListing', {...ctx.state, query: ctx.query, path: ctx.request.URL.pathname});
			}
			else {
				ctx.body = 'N/A';
			}
			return;
		}
		await next();
	});

	// Handle github webhook
	app.use(async (ctx, next) => {
		if (ctx.state.post) {
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
