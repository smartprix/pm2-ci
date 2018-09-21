const path = require('path');
const Handlebars = require('handlebars');

const hbs = Handlebars.create();
const {file} = require('sm-utils');

const form = file(`${__dirname}/../templates/appForm.hbs`);
form.read().then((data) => {
    const appFormTemplate = Handlebars.compile(data);
	hbs.registerPartial('appForm', appFormTemplate) 
});

hbs.registerHelper('tests', (db) => {
	if (Array.isArray(db)) return db.map(doc => doc.data);
	return [];
});

hbs.registerHelper('join', (arr) => {
	if(Array.isArray(arr)) return arr.join(', ');
	return '';
});

hbs.registerHelper('envVars', (envVars) => {
	return Object.keys(envVars || {}).filter(key => Boolean(key) && Boolean(envVars[key])).map(key => `${key}=${envVars[key]}`).join('\n');
})

hbs.registerHelper('pageLink', (pageNumber, query, pathname) => {
	query.page = pageNumber;
	const qs = Object.keys(query).map(key => `${key}=${query[key]}`).join('&');
	return `${pathname}?${qs}`;
});

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

