## Description

PM2 module to receive http webhook from github, execute pre/post hook and gracefull reload the application using pm2.

This is a fork of the original [pm2-githook](https://github.com/vmarchaud/pm2-githook) by vmarchaud. I found the error reporting lacking, ended up adding a few things like:
* A different log dir which includes the hook outputs (didn't want to populate pm2 logs with anything more than success/error messages)
* Automatic kill of any old running hooks for when your git pushes happen quicker than your hook completes
* A test runner, the repository will be cloned in a temp dir and tests run before pulling the application (tests should exit with 0 for success and 1 for failure)
* If your tests output [mochawesome](https://github.com/adamgruber/mochawesome) results, they can be served using the already active http server for githooks.
	Report will be available at `http://127.0.0.1:8888/APP_NAME/COMMIT_HASH`, with the latest one being available at `http://127.0.0.1:8888/APP_NAME`
* Slack notifications, receive slack notification on successfull deployment and tests passing/failing

## Install/Update

`pm2 install rohit-smpx/pm2-githook2`

For now this is the way, until I publish this to npm.

## Configure

```
{
	// Contains configuration of applications you want managed by pm2-githook2
	"apps": {
		// Example app
		"app_name": {
			// Github webhook secret
			"secret": "mysecret",
			// If tests are to be run before deploying application, remove this key if not
			// If yes, a new temporary directory is created and tests run
			"tests": {
				// The test command to run (should exit with 0 for SUCCESS and any other for FAILURE)
				// Should also include any prerequisites' installation
				"testCmd": "npm run install && npm run test",
				// Mochawesome reports can be parsed and results served through a webserver and slack
				// Report path relative to project directory
				"reportPath": "testReport/filename",
				// Git bisect can be used to find the commit where tests started failing
				// Specifiy the commit where tests were confirmed to be working and reports being generated
				"lastGoodCommit": "COMMIT_HASH",
				// IF tests are to be used only for reporting and not depolyment
				"deployAnyway": true
			},
			// The prerequisites before restarting the application
			"prehook": "npm install --production && git submodule update --init",
			// After restarting the application
			"posthook": "echo done",
			// Currently only works with github
			"service": "github",
			// The git repo information, required for tests
			"git": {
				// Specifiy token if repo is private and using https origin
				"token": "",
				// Specify remote url of repo if repo is private and using SSH origin
				"remoteUrl": ""
			},
			// If a private config is required for running your apllication specify it's path relative to app's root
			// It will copy this from your project root to the temporary directory for tests
			"privateConfig": "private/config.js"
		}
	},
	// If serving tests, the host where they are being served
	"host": "http://127.0.0.1",
	// Slack info to send updates
	"slack": {
		"webhook": "https://hooks.slack.com/services/XXXXXXXXX/XXXXXXXXX/XXXXXXXXXXXXXXXXXXXXXXXX",
		// Leave channel blank if you want to disable slack
		"channel": ""
	},	
	"logsDir": "/smartprix/logs/server_logs/pm2/githook",
	"port": 8888
}
```

#### How to set these values ?

 After having installed the module you have to type :
`pm2 set pm2-githook:key value`

To set the `apps` option and since its a json string, i advice you to escape it to be sure that the string is correctly set ([using this kind of tool](http://bernhardhaeussner.de/odd/json-escape/)).

e.g: 
- `pm2 set pm2-githook:port 8080` (bind the http server port to 8080)
- `pm2 set pm2-githook:apps "{\"APP_NAME\":{\"secret\":\"supersecret\",\"prehook\":\"npm install --production && git submodule update --init\",\"posthook\":\"echo done\"}}"` 

Or use 
`pm2 conf`
Edit the file and save. And then restart/reinstall module

## Uninstall

`pm2 uninstall pm2-githook2`

## Credits

[@vmarchaud](https://github.com/vmarchaud) for the original [pm2-githook](https://github.com/vmarchaud/pm2-githook) module on which this is based.
And to any other [contributors](https://github.com/vmarchaud/pm2-githook/graphs/contributors) of the original module.