const path = require('path');
const Handlebars = require('handlebars');

const hbs = Handlebars.create();

hbs.registerHelper('tests', (db, appName) => {
	if (db === null || db === undefined) return [];
	return Object.values(db[appName]).sort((a, b) => {
		if (a.commit.time === undefined && b.commit.time === undefined) return 0;
		if (a.commit.time === undefined) return 1;
		if (b.commit.time === undefined) return -1;
		if (a.commit.time > b.commit.time) return -1;
		if (a.commit.time < b.commit.time) return 1;
		return 0;
	});
});

hbs.registerHelper('add', (a, b) => a + b);

module.exports = {
	options: {
		cacheExpires: 60,
		contentTag: 'content',
		extension: '.hbs',
		hbs,
		paths: {
			views: path.join(__dirname, '/../templates'),
		},
		Promise,
	},
};

