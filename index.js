/*
Copyright Netfoundry, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const SegfaultHandler = require('segfault-handler');
SegfaultHandler.registerHandler('log/crash.log');
                  require('dotenv').config();
const path      = require('path');
const fs        = require('fs');
const connect   = require('connect');
const httpProxy = require('./lib/http-proxy');
const common    = require('./lib/http-proxy/common');
const terminate = require('./lib/terminate');
const pjson     = require('./package.json');
const winston   = require('winston');
require('winston-daily-rotate-file');
// const serveStatic = require('serve-static');
const heapdump  = require('heapdump');
const greenlock = require('greenlock');
const greenlock_express = require("greenlock-express");



var logger;     // for ziti-http-agent
var log_file    // for ...

var ziti;

/**
 * 
 */
var ziti_sdk_js_src = process.env.ZITI_SDK_JS_SRC

/**
 * 
 */
var target_scheme = process.env.ZITI_AGENT_TARGET_SCHEME
if (typeof target_scheme === 'undefined') { target_scheme = 'https'; }
var target_host = process.env.ZITI_AGENT_TARGET_HOST
var target_port = process.env.ZITI_AGENT_TARGET_PORT

/**
 * 
 */
var agent_host = process.env.ZITI_AGENT_HOST;
var agent_port = process.env.ZITI_AGENT_PORT


/**
 * 
 */
var agent_identity_path = process.env.ZITI_AGENT_IDENTITY_PATH

/**
 * 
 */
var ziti_agent_loglevel = process.env.ZITI_AGENT_LOGLEVEL


/**
 * 
 */
var ziti_inject_html = `
<!-- config for the Ziti JS SDK -->
<script type="text/javascript">${common.generateZitiConfig()}</script>
<!-- load the Ziti JS SDK itself -->
<script type="text/javascript" src="https://${ziti_sdk_js_src}"></script>
`;


/** --------------------------------------------------------------------------------------------------
 *  Create logger 
 */
const createLogger = () => {

    var logDir = 'log';

    if ( !fs.existsSync( logDir ) ) {
        fs.mkdirSync( logDir );
    }

    const { combine, timestamp, label, printf, splat } = winston.format;

    const logFormat = printf(({ level, message, durationMs, timestamp }) => {
        if (typeof durationMs !== 'undefined') {
            return `${timestamp} ${level}: [${durationMs}ms]: ${message}`;
        } else {
            return `${timestamp} ${level}: ${message}`;
        }
    });


    var logger = winston.createLogger({
        level: ziti_agent_loglevel,
        format: combine(
            splat(),
            timestamp(),
            logFormat
        ),
        transports: [
            new winston.transports.Console({format: combine( timestamp(), logFormat ), }),
        ],
        exceptionHandlers: [    // handle Uncaught exceptions
            new winston.transports.File({ filename: path.join(__dirname, logDir, '/ziti-http-agent-uncaught-exceptions.log' ) })
        ],
        rejectionHandlers: [    // handle Uncaught Promise Rejections
            new winston.transports.File({ filename: path.join(__dirname, logDir, '/ziti-http-agent-uncaught-promise-rejections.log' ) })
        ],
        exitOnError: false,     // Don't die if we encounter an uncaught exception or promise rejection
    });
    

    return( logger );
}



var selects = [];


/** --------------------------------------------------------------------------------------------------
 *  Initialize the Ziti NodeJS SDK 
 */
const zitiInit = () => {

    return new Promise((resolve, reject) => {

        var rc = ziti.ziti_init( agent_identity_path , ( init_rc ) => {
            if (init_rc < 0) {
                return reject('ziti_init failed');
            }
            return resolve();
        });

        if (rc < 0) {
            return reject('ziti_init failed');
        }

    });
};


/** --------------------------------------------------------------------------------------------------
 *  Start the agent
 */
const startAgent = ( logger ) => {

    logger.info(`Agent starting`);

    /** --------------------------------------------------------------------------------------------------
     *  Dynamically modify the proxied site's <head> element as we stream it back to the browser.  We will:
     *  1) inject the zitiConfig needed by the SDK
     *  2) inject the Ziti JS SDK
     */
    var headselect = {};

    headselect.query = 'head';
    headselect.func = function (node) {

        node.rs = node.createReadStream();
        node.ws = node.createWriteStream({outer: false, emitClose: true});

        node.rs.on('error', () => {
            node.ws.end();
            this.destroy();
        });
         
        node.rs.on('end', () => {
            node.ws.end();
            node.rs = null;
            node.ws = null;
        });

        // Inject the Ziti JS SDK at the front of <head> element so we are prepared to intercept as soon as possible over on the browser
        node.ws.write( ziti_inject_html );

        // Read the node and put it back into our write stream.
        node.rs.pipe(node.ws, {});	
    } 

    selects.push(headselect);
    /** -------------------------------------------------------------------------------------------------- */


    /** --------------------------------------------------------------------------------------------------
     *  Dynamically modify the proxied site's <meta http-equiv="Content-Security-Policy" ...>  element as 
     *  we stream it back to the browser.  We will ensure that:
     *  1) the CSP will allow loading the Ziti JS SDK from specified CDN
     *  2) the CSP will allow webassembly (used within the Ziti JS SDK) to load
     *  3) the CSP will allow the above-injected inline JS (SDK config) to execute
     */
    var metaselect = {};

    metaselect.query = 'meta';
    metaselect.func = function (node) {

        var attr = node.getAttribute('http-equiv');
        if (typeof attr !== 'undefined') {

            if (attr === 'Content-Security-Policy') {

                var content = node.getAttribute('content');
                if (typeof content !== 'undefined') {

                    content += ' * ' + ziti_sdk_js_src + "/ 'unsafe-inline' 'unsafe-eval'";

                    node.setAttribute('content', content);
                }
            }
        }
    } 

    selects.push(metaselect);
    /** -------------------------------------------------------------------------------------------------- */


    /** --------------------------------------------------------------------------------------------------
     *  Initiate the proxy and engage the above content injectors.
     */
    // var app = connect();

    // var proxy = httpProxy.createProxyServer({
    //     ziti: ziti,
    //     logger: logger,
    //     changeOrigin: true,
    //     target: target_scheme + '://' + target_host + ':' + target_port
    // });

    // // console.log('----: ', path.join(__dirname, 'ziti-static/js'));
    // // app.use(serveStatic(path.join(__dirname, 'ziti-static/js')));

    // app.use(require('./lib/inject')([], selects));

    // app.use(function (req, res) {
    //     proxy.web(req, res);
    // })

    // // if(process.env.NODE_ENV === 'production') {
        // app.use((req, res, next) => {
        //     if (req.header('x-forwarded-proto') !== 'https') {
        //         res.redirect(`https://${req.header('host')}${req.url}`)
        //     } else {
        //         next()
        //     }
        // })
    // // }

    // const server = http.createServer(app).listen( agent_port );

    // var options = {
    //     key: fs.readFileSync('test/fixtures/keys/agent2-key.pem'),
    //     cert: fs.readFileSync('test/fixtures/keys/agent2-cert.cert')
    // };

    // const server = https.createServer(options, app).listen( agent_port );

    // const exitHandler = terminate( server, {
    //     logger: logger,
    //     coredump: true,
    //     timeout: 500
    // });

    // process.on('uncaughtException', exitHandler(1, 'Unexpected Error'))
    // process.on('unhandledRejection', exitHandler(1, 'Unhandled Promise'))
    // process.on('SIGTERM', exitHandler(0, 'SIGTERM'))
    // process.on('SIGINT', exitHandler(0, 'SIGINT'))
    
    //
    // var greenlock = require('greenlock')
    // logger.info('greenlock.sites is: %o', greenlock.sites);

    // logger.info(`doing greenlock.sites.set of ${agent_host}  at ${new Date()}`);
    // greenlock.sites.set({
    //     subject: agent_host,
    //     altnames: [agent_host]
    // });

    // var greenlock_express = require("greenlock-express")
    // logger.info('greenlock is: %o', greenlock);

    // logger.info(`greenlock.sites.add is: ${greenlock.sites.add}`);
    // logger.info(`doing greenlock.sites.add  at ${new Date()}`);
    // greenlock.sites.add({
    //     subject: agent_host,
    //     altnames: [agent_host]
    // });


    /** --------------------------------------------------------------------------------------------------
     *  Set up the Let's Encrypt infra.  
     * The configured 'agent_host' will be used when generating the TLS certs.
     */
    var gl = greenlock.create({
        packageRoot: __dirname,
        configDir: "./greenlock.d",
        maintainerEmail: "openziti@openziti.org",
        serverKeyType: "RSA-4096",
        cluster: false      
    });
    gl.sites.add({
        subject: agent_host,
        altnames: [agent_host]
    });
    var gle = greenlock_express.init({
        packageRoot: __dirname,
        configDir: "./greenlock.d",
        maintainerEmail: "openziti@openziti.org",
        cluster: false
    });
    gle.ready(httpsWorker);
    /** -------------------------------------------------------------------------------------------------- */

      

    /** --------------------------------------------------------------------------------------------------
     *  Initiate the proxy and engage the content injectors.
     */
    function httpsWorker( glx ) {

        logger.info(`httpsWorker starting`);

        var app = connect();

        var proxy = httpProxy.createProxyServer({
            ziti: ziti,
            logger: logger,
            changeOrigin: true,
            target: target_scheme + '://' + target_host + ':' + target_port
        });
        
        app.use(require('./lib/inject')([], selects));
    
        app.use(function (req, res) {
            proxy.web(req, res);
        })
    /** -------------------------------------------------------------------------------------------------- */
    

    /** --------------------------------------------------------------------------------------------------
     *  Crank up the web server (which will do all the magic regarding cert acquisition, refreshing, etc)
     */
        // Start a TLS-based listener on the configured port (typically 443)
        const httpsServer = glx.httpsServer(null, app);        
        httpsServer.listen( agent_port, "0.0.0.0", function() {
            logger.info('Listening on %o', httpsServer.address());
        });

        // ALSO listen on port 80 for ACME HTTP-01 Challenges
        // (the ACME and http->https middleware are loaded by glx.httpServer)
        var httpServer = glx.httpServer();
        httpServer.listen(80, "0.0.0.0", function() {
            logger.info('Listening on %o', httpServer.address());
        });
    }
    /** -------------------------------------------------------------------------------------------------- */
    
};


/**
 * 
 */
const main = async () => {

    logger = createLogger();

    logger.info(`ziti-http-agent version ${pjson.version} starting at ${new Date()}`);

    ziti = require('ziti-sdk-nodejs');
    require('assert').strictEqual(ziti.ziti_hello(),"ziti");

    zitiInit().then( () =>  {
        logger.info('zitiInit() completed');
    } ).catch((err) => {
        logger.error('FAILURE: (%s)', err);
        winston.log_and_exit("info","bye",1);
        setTimeout(function(){  
            process.exit(-1);
        }, 1000);
    });


    // Now start the Ziti HTTP Agent
    startAgent( logger );

};
  
main();
  