const path = require('path');
const _ = require('lodash');
const Router = require('koa-router');
const send = require('koa-send');

const db = require('../lib/db');
const logger = require('../lib/logger');
const {Vars} = require('../lib/common');


router = Router();


const setAppMiddleware = (ctx, next) => {
    const appName = ctx.params.appName;
    if (appName) {
        ctx.state.appName = appName;
        ctx.state.app = ctx.worker.apps[appName];
        const dataDir = ctx.worker.opts.dataDir;
        ctx.vars = new Vars(dataDir, appName);
    }
    return next();
}
/**
 * 
 * @param {*} ctx 
 * @param {String} filePath file path
 */
async function serveFile(ctx, filePath, root) {
    const ext = path.extname(filePath).slice(1);
    let type = '';
    switch (ext) {
        case 'js': type = 'application/javascript'; break;
        default: type = 'text/' + ext;
    }
    ctx.set('Content-type', type);

    try {
        await send(ctx, filePath, {
            gzip: true,
            root: root || ctx.vars.dataDir,
            maxAge: 30 * 24 * 60 * 60 * 1000,
        });
    }
    catch (e) {
        logger.error('File not found', filePath, e);
        ctx.status = 404;
        ctx.state.msg = `Commit's (${ctx.params.commit}) report not found!`;
        await ctx.render('testListing', ctx.state);
    }
}

/**
 * get app config from query
 * @param {Object} query 
 * @returns {Object} app config
 */
function getAppConfig(query) {
    const appConfig = _.pick(query, ['appName', 'secret', 'prehook', 'posthook', 'cwd', 'slackChannel']);
    appConfig.debug = query.debug === 'on';
    appConfig.bisect = query.bisect === 'on';
    appConfig.branches = query.branches.trim().split(',').map(branch => branch.trim()).filter(Boolean);

    appConfig.tests = _.pick(query, ['privateConfig', 'testCmd', 'lastGoodCommit', 'githubToken']);
    appConfig.tests.deployAnyway = query.deployAnyway === 'on';
    return appConfig;
}

// root : localhost:8880/
router.get('/', async (ctx) => {
    ctx.state.apps = Object.keys(ctx.worker.apps);
    await ctx.render('appListing', ctx.state);
});

router.get('/assets/:asset', async (ctx) => {
    await serveFile(ctx, ctx.params.asset, path.join(__dirname, '../templates/assets'));
})

// add app : localhost:8880/
router.get('/apps/add', async (ctx) => {
    const query = ctx.query;
    if (ctx.worker.apps[query.appName]) {
        ctx.state.msg = `App ${ctx.state.appName} already exists in config`;
    }
    else if (query.appName && query.secret) {
        const appConfig = getAppConfig(query);
        await ctx.worker.upsertAppConfig(query.appName, appConfig);
        ctx.redirect(`/${query.appName}`);
        return;
    }
    else {
        ctx.state.msg = 'App Name and Secret are required';
    }
    await ctx.render('testListing', ctx.state);
});

// app info : localhost:8880/sm-crawler-dev/
router.get('/:appName', setAppMiddleware, async (ctx) => {
    if (!ctx.state.appName) {
        ctx.state.msg = ctx.query.msg;
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
});

// Github webhook
router.post('/:appName', setAppMiddleware, async (ctx) => {
    ctx.body = 'OK';
    // get the whole body before processing
    ctx.request.body = '';
    ctx.req.on('data', (data) => {
        ctx.request.body += data;
    }).on('end', () => {
        ctx.worker.handleRequest(ctx);
    });
    return;
})

// edit app : localhost:8880/sm-crawler-dev/edit
router.get('/:appName/edit', setAppMiddleware, async (ctx) => {
    if (ctx.state.app) {
        const query = ctx.query;
        const oldConfig = ctx.state.app;

        if (query.appName !== ctx.state.appName && ctx.worker.apps[query.appName]) {
            ctx.state.msg = 'Existing app with same name exists!';
        }
        else if (query.oldSecret === oldConfig.secret) { 
            const appConfig = getAppConfig(query);
            appConfig.secret = appConfig.secret || query.oldSecret;
            
            const res = await ctx.worker.upsertAppConfig(ctx.state.appName, appConfig);
            if (query.appName !== ctx.state.appName) {
                ctx.redirect(`/${query.appName}`);
                return;
            }
            ctx.state.app = res;
        }
        else ctx.state.msg = 'Wrong Secret';
        await ctx.render('testListing', ctx.state);
        return;
    }
});

// delete app : localhost:8880/sm-crawler-dev/delete
router.post('/:appName/delete', setAppMiddleware, async (ctx) => {
    if (ctx.state.app) {
        try {
            await db.deleteApp(ctx.vars.appName, ctx.vars.appDir);
            await ctx.worker.reloadApps();
            ctx.body = {
                msg: ctx.vars.appName + ' deleted!',
                status: true,
            }
        }
        catch(err) {
            logger.error('Delete app error:', err);
            ctx.body = {status: false};
        }
        return;
    }
});

// manual hook : localhost:8880/sm-crawler-dev/hook
router.get('/:appName/hook', setAppMiddleware, async (ctx) => {
    const query = ctx.query;
    if (ctx.state.app && query.secret === ctx.state.app.secret) {
        ctx.worker.handleRequest(ctx, true, (query.deploy === 'on' && !query.commit));
        ctx.state.msg = `Started Hook for ${ctx.state.appName}, for commit ${query.commit || 'LATEST'}`;
    }
    else if (!ctx.state.app) {
        ctx.state.msg = `App ${ctx.state.appName} doesn't exist in config`;
    }
    else ctx.state.msg = 'Wrong Secret';
    await ctx.render('testListing', ctx.state);
});

// test report
router.get('/:appName/:commit([A-Fa-f0-9]{40})', setAppMiddleware, async (ctx) => {
    if (ctx.state.app) {
        let filePath = ctx.vars.testDestHtml(ctx.params.commit);
        filePath = filePath.slice(ctx.vars.dataDir.length);
        await serveFile(ctx, filePath);
    }
});

// coverage report
router.get('/:appName/:commit([A-Fa-f0-9]{40})/coverage/:filePath([a-zA-z0-9-_/.]+)', setAppMiddleware, async (ctx) => {
    if (ctx.state.app) {
        filePath = path.join(ctx.vars.commitCoverageDestDir(ctx.params.commit), ctx.params.filePath);
        filePath = filePath.slice(ctx.vars.dataDir.length);
        await serveFile(ctx, filePath);
    }
});


module.exports = router;
