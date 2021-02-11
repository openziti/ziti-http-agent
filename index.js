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
// const greenlock = require('greenlock');
const greenlock_express = require("greenlock-express");
const pkg       = require('./package.json');
var os = require('os')
var Greenlock = require('greenlock');




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
var agent_http_port = process.env.ZITI_AGENT_HTTP_PORT
if (typeof agent_http_port === 'undefined') { agent_http_port = 8080; }
var agent_https_port = process.env.ZITI_AGENT_HTTPS_PORT
if (typeof agent_https_port === 'undefined') { agent_https_port = 8443; }


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

    var app = connect();

    /** --------------------------------------------------------------------------------------------------
     *  Set up the Let's Encrypt infra.  
     *  The configured 'agent_host' will be used when auto-generating the TLS certs.
     */


    // try {
    //     logger.info('now doing greenlock.create');

    //     var gl = greenlock.create({
    //         packageRoot: __dirname,
    //         agreeToTerms: true,
    //         configDir: "./greenlock.d",
    //         packageAgent: pkg.name + '/' + pkg.version,
    //         maintainerEmail: "openziti@netfoundry.io",
    //         serverKeyType: "RSA-2048",
    //         cluster: false,
    //         notify: function(event, details) {
    //             logger.info('greenlock event: %o, details: %o', event, details);
    //         }    
    //     });
    //     logger.info('greenlock.create completed');
        
    //     var altnames = ['mattermost.ziti.netfoundry.io', 'mattermost.ziti.netfoundry.io'];
    //     gl.sites.add({
    //         subject: altnames[0],
    //         altnames: altnames
    //     });
    //     logger.info('gl.sites.add completed');

    //     gl.get({ servername: altnames[0] }).then(function(pems) {
    //         if (pems && pems.privkey && pems.cert && pems.chain) {
    //             logger.info('greenlock.get Success');
    //         }
    //         logger.info('greenlock.get returns pems: %o', pems);
    //     })
    //     .catch(function(e) {
    //         logger.error('greenlock.get exception: %o', e);
    //     });
    // } catch (e) {
    //     logger.error('exception: %o', e);
    // }

    // var gle = greenlock_express.init({
    //     packageRoot: __dirname,
    //     agreeToTerms: true,
    //     packageAgent: pkg.name + '/' + pkg.version,
    //     configDir: "./greenlock.d",
    //     maintainerEmail: "openziti@netfoundry.io",
    //     cluster: false,
    //     notify: function(event, details) {
    //         logger.info('greenlock event: %o, details: %o', event, details);
    //     }    
    // });
    // gle.ready(httpsWorker);

    try {

        var domains = [ agent_host ];

        // Let's Encrypt staging API
        var acme_server =  'https://acme-staging-v02.api.letsencrypt.org/directory';
        // Let's Encrypt production API
        // var acme_server =  'https://acme-v02.api.letsencrypt.org/directory';
        

        // Storage Backend
        var leStore = require('le-store-certbot').create({
            configDir: '~/acme/etc'                                 // or /etc/letsencrypt or wherever
        , debug: true
        });
  
        // ACME Challenge Handlers
        var leHttpChallenge = require('le-challenge-fs').create({
            webrootPath: '~/acme/var/'                              // or template string such as
        , debug: true                                               // '/srv/www/:hostname/.well-known/acme-challenge'
        });
  
        function leAgree(opts, agreeCb) {
            agreeCb(null, opts.tosUrl);
        }
          
        var greenlock = Greenlock.create({
            version: 'draft-12'                                     // 'draft-12' or 'v01'
                                                                    // 'draft-12' is for Let's Encrypt v2 otherwise known as ACME draft 12
                                                                    // 'v02' is an alias for 'draft-12'
                                                                    // 'v01' is for the pre-spec Let's Encrypt v1
          , server: acme_server
                      
          , maintainerEmail: "openziti@netfoundry.io"

          , packageRoot: __dirname
          , configDir: "./greenlock.d"
          , packageAgent: pkg.name + '/' + pkg.version

          , store: leStore                                          // handles saving of config, accounts, and certificates
          , challenges: {
              'http-01': leHttpChallenge                            // handles /.well-known/acme-challege keys and tokens
            }
          , challengeType: 'http-01'                                // default to this challenge type
          , agreeToTerms: leAgree                                   // hook to allow user to view and accept LE TOS
           
                                                                    // renewals happen at a random time within this window
          , renewWithin: 14 * 24 * 60 * 60 * 1000                   // certificate renewal may begin at this time
          , renewBy:     10 * 24 * 60 * 60 * 1000                   // certificate renewal should happen by this time
           
          , debug: true
          , log: function (debug) {
              logger.debug('greenlock log: %o', debug);
            } 

          , serverKeyType: "RSA-2048"

          , cluster: false
          
          , notify: function(event, details) {
                logger.info('greenlock event: %o, details: %o', event, details);
            }    
        });

        //
        // app.use('/', greenlock.middleware());

        // // Check in-memory cache of certificates for the named domain
        greenlock.check({ domains: domains }).then(function (results) {

            if (results) {
                // we already have certificates
                return;
            }
        
            // Register Certificate manually
            greenlock.register({
        
                  domains: domains,
                  server: acme_server
                , email: 'openziti@netfoundry.io'                      
                , agreeTos: true                                      
                , rsaKeySize: 2048                            
                , challengeType: 'http-01'  // http-01, tls-sni-01, or dns-01
        
            }).then(function (results) {
        
                logger.info('Success: %o', results);
        
            }, function (err) {
        
                // Note: you must either use greenlock.middleware() with express,
                // manually use greenlock.challenges['http-01'].get(opts, domain, key, val, done)
                // or have a webserver running and responding
                // to /.well-known/acme-challenge at `webrootPath`
                logger.error(err);
            });
        });
            
        var gle = greenlock_express.init({
            version: 'draft-12',
            server: acme_server,
            packageRoot: __dirname,
            agreeToTerms: true,
            packageAgent: pkg.name + '/' + pkg.version,
            configDir: "./greenlock.d",
            maintainerEmail: "openziti@netfoundry.io",
            serverKeyType: "RSA-2048",
            cluster: false,
            notify: function(event, details) {
                logger.info('greenlock_express event: %o, details: %o', event, details);
            }    
        });

        // gle.sites.add({
        //     subject: domains[0],
        //     altnames: domains
        // });

        gle.ready(httpsWorker);

    } catch (e) {
        logger.error('exception: %o', e);
    }
    /** -------------------------------------------------------------------------------------------------- */

      

    /** --------------------------------------------------------------------------------------------------
     *  Initiate the proxy and engage the content injectors.
     */
    function httpsWorker( glx ) {

        logger.info(`httpsWorker starting`);

        // var app = connect();

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
     *  The 'agent_http_port' and 'agent_https_port' values can be arbitrary values since they are used
     *  inside the container.  The ports 80/443 are typically mapped onto the 'agent_http_port' and 
     *  'agent_https_port' values.  e.g.  80->8080 & 443->8443
     */
        // Start a TLS-based listener on the configured port
        const httpsServer = glx.httpsServer(null, app);        
        httpsServer.listen( agent_https_port, "0.0.0.0", function() {
            logger.info('Listening on %o', httpsServer.address());
        });

        // ALSO listen on port 80 for ACME HTTP-01 Challenges
        // (the ACME and http->https middleware are loaded by glx.httpServer)
        var httpServer = glx.httpServer();
        httpServer.listen( agent_http_port, "0.0.0.0", function() {
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
  