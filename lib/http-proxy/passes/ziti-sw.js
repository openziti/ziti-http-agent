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


/**
 * Dynamically load the Ziti JS SDK into the global scope used by this service worker.
 * Let the SDK know that it is being loaded into a serviceWorker scope (so it will not 
 * try to do any DOM/UI manipulations.
 */
zitiConfig.serviceWorker.active = true;
zitiConfig.realFetch = fetch;
self.importScripts( zitiConfig.httpAgent.zitiSDKjs.location );


/**
 * 
 */
async function sendMessageToClient( client, message ) {

    return new Promise( async function(resolve, reject) {

        console.log('ziti-sw: sendMessageToClient() processing msg: ', message);

        var messageChannel = new MessageChannel();

        messageChannel.port1.onmessage = function( event ) {
            console.log('ziti-sw: sendMessageToClient() onmessage(): reply event is: : ', event.data.response);
            if (event.data.error) {
                reject(event.data.error);
            } else {
                resolve(event.data.response);
            }
        };

        client.postMessage(message, [messageChannel.port2]);
    });
}


/**
 *  INSTALL:
 * 
 */
self.addEventListener('install', function(event) {
    console.log('ziti-sw: install event');

    const urlsToCache = ['/'];

    event.waitUntil(async function() {

        const allClients = await clients.matchAll({ includeUncontrolled: true });
        const client     = await clients.get(allClients[0].id);
        var resp;

        resp = await sendMessageToClient( client, { command: 'initClient', options: { logLevel: zitiConfig.httpAgent.zitiSDKjs.logLevel } } );
        console.log('ziti-sw: install() initClient resp is: : ', resp);

        resp = await sendMessageToClient( client, { command: 'setControllerApi', controller: zitiConfig.controller.api } );
        console.log('ziti-sw: install() setControllerApi resp is: : ', resp);

        resp = await sendMessageToClient( client, { command: 'generateKeyPair' } );
        console.log('ziti-sw: install() generateKeyPair resp is: : ', resp);

//TEMP
        // resp = await sendMessageToClient( client, { command: 'promptForZitiCreds' } );
        // console.log('ziti-sw: install() promptForZitiCreds resp is: : ', resp);

        // var cache = await caches.open('ziti_sdk_js');
        // await cache.addAll(urlsToCache);


        console.log('ziti-sw: install event, now calling skipWaiting()');
        self.skipWaiting();
    }());

});


/**
 *  ACTIVATE:
 * 
 */
self.addEventListener('activate', async function(event) {
    console.log('ziti-sw: activate event: ', event);
    event.waitUntil(self.clients.claim());
    console.log('ziti-sw: activate event completed clients.claim');
});


/**
 * 
 */
async function shouldDoInterceptInJSSDK( event ) {

    return new Promise( async (resolve) => {

        var url = event.request.url;
        var method = event.request.method;

        console.log('ziti-sw: shouldDoInterceptInJSSDK entered for: ', url);

        var requestUrl = new URL( event.request.url );

        // If scheme is https and URL did not specify a port, then default it to 443 on behalf of the regex below
        if (requestUrl.protocol === 'https:') {
            if (requestUrl.port === '') {
                url = requestUrl.protocol + '//' + requestUrl.hostname + ':443' + requestUrl.pathname;
            }
        }

        // We want to intercept fetch requests that target the Ziti HTTP Agent
        var regex = new RegExp( zitiConfig.httpAgent.self.host + ':443' , 'g' );
        // We want to intercept fetch requests that target socket.io/COOKIE/jwts/_h_t_m_l_5_r_d_p.html
        // var siocregex = new RegExp( 'socket.io/COOKIE/jwts/_h_t_m_l_5_r_d_p.html?' , 'g' );
        var siocregex2 = new RegExp( 'software/html5.html' , 'g' );

        if (url.match( regex )) {   // request is indeed targeting Ziti HTTP Agent

            // Ensure the browser, not this service worker, does the fetch of the root page
            if ( requestUrl.pathname === '/' ) {
            
                console.log('ziti-sw: shouldDoInterceptInJSSDK returning FALSE (root path) for: ', url);
                resolve( false );
                return;
            }

            // else if (url.match( siocregex )) {

            //     console.log('ziti-sw: shouldDoInterceptInJSSDK returning FALSE (socket.io/COOKIE/jwts/_h_t_m_l_5_r_d_p.html path) for: ', url);
            //     resolve( false );
            //     return;
    
            // }    

            else if (url.match( siocregex2 )) {

                console.log('ziti-sw: shouldDoInterceptInJSSDK returning FALSE (software/html5.html path) for: ', url);
                resolve( false );
                return;
    
            }    

            // Ensure the browser, not this service worker, does the (re)fetch of the page that caused sdk injection.
            else if ( method === 'GET' && requestUrl.pathname === zitiConfig.httpAgent.zitiSDKjsInjectionURL.location ) {
            
                console.log('ziti-sw: shouldDoInterceptInJSSDK returning FALSE for: ', url);
                resolve( false );
                return;

            } else {

                console.log('ziti-sw: shouldDoInterceptInJSSDK TRUE for: ', url);
                console.log('ziti-sw: shouldDoInterceptInJSSDK self.identityLoaded is: ', self.identityLoaded);

                /**
                 * Since we will be routing the request over Ziti, do NOT proceed until we have the necessary Ziti network credentials.
                 * 
                 * If the client has already obtained the creds, and has signaled this fact to us, then do not ask client.
                 */
                if (self.identityLoaded) {
                    console.log('ziti-sw: shouldDoInterceptInJSSDK returning TRUE since self.identityLoaded = true');
                    resolve( true );
                    return;
                }

                /** 
                 * Otherwise we do an 'awaitIdentityLoaded' command over to the client (page), instead of just looking in IndexedDB, because
                 * if we do NOT have a viable Identity, we will need to prompt the user for their Ziti UPDB creds, and this prompt
                 * requires us to render a UI via DHTML.  Here in the service worker, we have NO access to the DOM, so the UI is managed
                 * over in the client (page).
                 */
                console.log('ziti-sw: await clients.get for clientId: ', event.clientId);
                const client = await self.clients.get(event.clientId);
                if (!client) {
                    console.log('ziti-sw: clients.get returned null, returning FALSE for: ', url);
                    resolve( false );
                    return;            
                }
      
                console.log('ziti-sw: shouldDoInterceptInJSSDK now doing awaitIdentityLoaded for: ', url);
                let resp = await sendMessageToClient( client, { command: 'awaitIdentityLoaded', options: { logLevel: zitiConfig.httpAgent.zitiSDKjs.logLevel } } );
                console.log('ziti-sw: fetch() awaitIdentityLoaded resp is: : ', resp);
    
                console.log('ziti-sw: shouldDoInterceptInJSSDK returning TRUE for: ', url);
                resolve( true );
                return;
            }
        }

        // All other requests should be handled by the browser
        console.log('ziti-sw: shouldDoInterceptInJSSDK returning FALSE for: ', url);
        resolve( false );
        return;
    });
}


/**
 * 
 */
async function getRequestBody( zitiRequest ) {
    return new Promise( async (resolve) => {
        var requestBlob = await zitiRequest.blob();
        if (requestBlob.size > 0) {
            return resolve( requestBlob );
        }
        return resolve( undefined );
    });
}


function dumpHeaders(headersObject) {
    for (var pair of headersObject.entries()) {
        console.log( 'ziti-sw: dumpHeaders: ', pair[0], pair[1]);
    }
}

/**
 *  FETCH:
 * 
 */
self.addEventListener('fetch', async function( event ) {

    console.log( 'ziti-sw: fetch starting for url: ', event.request.url);

    event.respondWith(async function() {

        return new Promise( async (resolve) => {

            console.log( 'ziti-sw: inside event.respondWith, BEFORE shouldDoInterceptInJSSDK() for: ', event.request.url);
            var doInterceptInJSSDK = await shouldDoInterceptInJSSDK( event ).catch( async (err) => {

                console.log( 'ziti-sw: shouldDoInterceptInJSSDK error: fetch NOT intercepting', err); 
        
                var response = await fetch(event.request);

                return resolve( response );

            });

            if ( !doInterceptInJSSDK ) {

                console.log( 'ziti-sw: doing HTTP Agent fetch for: ', event.request.url); 
        
                var response = await fetch(event.request);

                console.log( 'ziti-sw: HTTP Agent response returned from: ', event.request.url); 

                return resolve( response );
        
            } else {

                console.log( 'ziti-sw: fetch IS intercepting: ', event.request.url); 

                // dumpHeaders(event.request.headers);

                /**
                 * Retarget the request from the Ziti HTTP Agent over to the (dark) target host
                 */
                var newUrl = new URL( event.request.url );
                newUrl.hostname = zitiConfig.httpAgent.target.host;
                newUrl.port = zitiConfig.httpAgent.target.port;
                console.log( 'ziti-sw: transformed URL: ', newUrl.toString());

                /**
                 * Instantiate a fresh HTTP Request object that we will push through the ziti-sdk-js which will:
                 * 
                 * 1) contain re-routed host
                 * 2) have any headers we need to pile on
                 * 3) prepare to stream out any body data associated with the intercepted request
                 */                 
                const zitiRequest = new Request(event.request, {
                });
                var blob = await getRequestBody( zitiRequest );
                var zitiResponse = await ziti.fetchFromServiceWorker(
                    newUrl.toString(), {
                        method:         zitiRequest.method, 
                        headers:        zitiRequest.headers,
                        mode:           zitiRequest.mode,
                        cache:          zitiRequest.cache,
                        credentials:    zitiRequest.credentials,
                        redirect:       zitiRequest.redirect,
                        referrerPolicy: zitiRequest.referrerPolicy,
                        body:           blob
                    }
                );        

                /**
                 * Now that ziti-sdk-js has returned us a ZitiResponse, instantiate a fresh Response object that we 
                 * will return to the Browser. This requires us to:
                 * 
                 * 1) propagate the HTTP headers, status, etc
                 * 2) pipe the HTTP response body 
                 */

                var zitiHeaders = zitiResponse.headers.raw();
                var headers = new Headers();
                const keys = Object.keys(zitiHeaders);
                for (let i = 0; i < keys.length; i++) {
                  const key = keys[i];
                  const val = zitiHeaders[key][0];
                  headers.append( key, val);
                //   console.log( 'ziti-sw: zitiResponse.headers: ', key, val); 
                }
                headers.append( 'x-ziti-http-agent-sdk-js-version', ziti.VERSION );

                var responseBlob = await zitiResponse.blob();
                var responseBlobStream = responseBlob.stream();               
                const responseStream = new ReadableStream({
                    start(controller) {
                        function push() {
                            var chunk = responseBlobStream.read();
                            if (chunk) {
                                controller.enqueue(chunk);
                                push();  
                            } else {
                                controller.close();
                                return;
                            }
                        };
                        push();
                    }
                });

                var response = new Response( responseStream, { "status": zitiResponse.status, "headers":  headers } );
                
                return resolve( response );
            }
        });

    }());
    
});


/**
 *  Client response sender
 */
_sendResponse = ( event, responseObject ) => {

    var data = {
        command: event.data.command,  // echo this back
        response: responseObject
    };
    event.ports[0].postMessage( data );
}


/**
 *  identityLoaded 'message' handler
 */
 _onMessage_identityLoaded = async ( event ) => {
    self.identityLoaded = event.data.identityLoaded.value;
    console.log('ziti-sw: self.identityLoaded now set to: ', self.identityLoaded);

    _sendResponse( event, 'OK' );
}


/**
 *  nop 'message' handler
 */
_onMessage_nop = async ( event ) => {
    _sendResponse( event, 'nop OK' );
}
  

/**
 *  Client 'message' router
 */
 addEventListener('message', event => {

    console.log('ziti-sw: received msg from client: ', event);

         if (event.data.command === 'identityLoaded')       { _onMessage_identityLoaded( event ); }
    else if (event.data.command === 'nop')                  { _onMessage_nop( event ); }

    else { throw new Error('unknown message.command received [' + event.data.command + ']'); }
});
