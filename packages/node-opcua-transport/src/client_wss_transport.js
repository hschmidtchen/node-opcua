"use strict";
/**
 * @module opcua.transport
 */


// system requires
var assert = require("node-opcua-assert");

var net = require("net");
var https = require("https");
var fs = require("fs");
var _ = require("underscore");
var util = require("util");
var path = require("path");


// opcua requires
var BinaryStream = require("node-opcua-binary-stream").BinaryStream;

// this modules
var WSS_transport = require("./wss_transport").WSS_transport;

var getFakeTransport = require("./tcp_transport").getFakeTransport;

var packTcpMessage = require("./tools").packTcpMessage;
var parseEndpointUrl = require("./tools").parseEndpointUrl;

var HelloMessage = require("../_generated_/_auto_generated_HelloMessage").HelloMessage;
var TCPErrorMessage = require("../_generated_/_auto_generated_TCPErrorMessage").TCPErrorMessage;
var AcknowledgeMessage = require("../_generated_/_auto_generated_AcknowledgeMessage").AcknowledgeMessage;

var debugLog = require("node-opcua-debug").make_debugLog(__filename);

var WebSocket = require('ws');

var readMessageHeader = require("node-opcua-chunkmanager").readMessageHeader;

var decodeMessage = require("./tools").decodeMessage;

/**
 * a ClientWSS_transport connects to a remote server socket and
 * initiates a communication with a HEL/ACK transaction.
 * It negociates the communication parameters with the other end.
 *
 * @class ClientWSS_transport
 * @extends WSS_transport
 * @constructor
 *
 *
 *
 * @example
 *
 *    ```javascript
 *    var transport = ClientWSS_transport(url);
 *
 *    transport.timeout = 1000;
 *
 *    transport.connect(function(err)) {
 *         if (err) {
 *            // cannot connect
 *         } else {
 *            // connected
 *
 *         }
 *    });
 *    ....
 *
 *    transport.write(message_chunk,'F');
 *
 *    ....
 *
 *    transport.on("message",function(message_chunk) {
 *        // do something with message from server...
 *    });
 *
 *
 *    ```
 *
 *
 */
var ClientWSS_transport = function (isPassive, client) {
    WSS_transport.call(this);
    var self = this;
    self.connected = false;
    self._isPassive=isPassive;
    self._client = client;
};
util.inherits(ClientWSS_transport, WSS_transport);

/*ClientWSS_transport.prototype.close=function(){
    var self = this;
    if(self._server !== null){
        self._server.close();
        self._server=null;
    }
};*/

ClientWSS_transport.prototype._createClientSocket = function(endpointUrl, callback) {
    var self=this;

    // create a socket based on Url
    var ep = parseEndpointUrl(endpointUrl);
    var port = ep.port;
    var hostname = ep.hostname;

    debugLog("passive: "+self._isPassive);

    if(self._isPassive){
        debugLog("Passive branch! ");  

        //create WebsocketServer
        self._server = new WebSocket.Server({ server: self._client._httpsServer});
        //self._server = new WebSocket.Server({ port: self.port});              

        self._server.on("connection", function (socket, req) {

            //kill the server if the socket gets closed
            socket.on("close",function(){
                self._server.close();
            });

            // istanbul ignore next
            debugLog("WS client passive incoming connection: "+req.connection.remoteAddress);
            self._socket = socket;
            self._connect_end(callback);
    
        }).on("close", function () {
            debugLog("WS client passive server closed : all connections have ended");
            self._server=null;
        }).on("error", function (err) {
            // this could be because the port is already in use
            debugLog("WS client passive server error: ".red.bold, err.message);
            self.emit("error",err);
        });

        self._client._httpsServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
              console.log('Address in use, retrying...');
              setTimeout(() => {
                self._client._httpsServer.close();
                self._client._httpsServer.listen(port,function listening() {
                    debugLog("WS client passive server listening: "+endpointUrl);
                }); 
              }, 1000);
            }
        });
        
        self._client._httpsServer.listen(port,function listening() {
            debugLog("WS client passive server listening: "+endpointUrl);
        }); 
    }
    else{        
        //workaround since ws does not recognize opc.wss as secure 
        self._socket = new WebSocket(endpointUrl.substring(4),{rejectUnauthorized: false});
        //var socket = new WebSocket(endpointUrl,{rejectUnauthorized: false});
        self._connect_end(callback);
    }
}

ClientWSS_transport.prototype.on_socket_ended = function(err) {

    var self = this;
    if (self.connected) {
        WSS_transport.prototype.on_socket_ended.call(self,err);
    }
};

/**
 * @method connect
 * @async
 * @param endpointUrl {String}
 * @param callback {Function} the callback function
 * @param [options={}]
 */
ClientWSS_transport.prototype.connect = function (endpointUrl, callback, options) {

    assert(_.isFunction(callback));

    options = options || {};

    var self = this;

    self.protocolVersion = (options.protocolVersion !== undefined) ? options.protocolVersion : self.protocolVersion;
    assert(_.isFinite(self.protocolVersion));

    var ep = parseEndpointUrl(endpointUrl);

    var hostname = require("os").hostname();

    self.endpointUrl = endpointUrl;

    self.serverUri = "urn:" + hostname + ":Sample";

    debugLog("endpointUrl =", endpointUrl, "ep", ep);

    try {
        self._createClientSocket(endpointUrl, callback);
    }
    catch (err) {
        return callback(err);
    }
}

ClientWSS_transport.prototype._connect_end = function (callback) {
    var self = this;
    debugLog("connect_end!")
    self._socket.name = "CLIENT";
    self._install_socket(self._socket);

    function _on_socket_error_for_connect(err) {
        // this handler will catch attempt to connect to an inaccessible address.
        assert(err instanceof Error);
        _remove_connect_listeners();
        callback(err);
    }
    function _on_socket_end_for_connect(err) {
        console.log("Socket has been closed by server",err);
    }

    function _remove_connect_listeners() {
        self._socket.removeListener("error", _on_socket_error_for_connect);
        self._socket.removeListener("close"  , _on_socket_end_for_connect);
    }

    function _on_socket_error_after_connection(err) {
        debugLog(" ClientWSS_transport Socket Error",err.message);
        
        // EPIPE : EPIPE (Broken pipe): A write on a pipe, socket, or FIFO for which there is no process to read the
        // data. Commonly encountered at the net and http layers, indicative that the remote side of the stream being
        // written to has been closed.

        // ECONNRESET (Connection reset by peer): A connection was forcibly closed by a peer. This normally results
        // from a loss of the connection on the remote socket due to a timeout or reboot. Commonly encountered via the
        // http and net modu


        if (err.message.match(/ECONNRESET|EPIPE/)) {
            /**
             * @event connection_break
             *
             */
            self.emit("connection_break");
        }

        if(self._isPassive){
            self._socket.close();
        }
    }
    
    debugLog("client wss transp reg listeners");

    self._socket.once("error", _on_socket_error_for_connect);
    self._socket.once("close",_on_socket_end_for_connect);

    self._socket.on("open", function () {

        debugLog("socket open");
        _remove_connect_listeners();

        self._perform_HEL_ACK_transaction(function(err) {
            if(!err) {

                // install error handler to detect connection break
                self._socket.on("error",_on_socket_error_after_connection);

                self.connected = true;
                /**
                 * notify the observers that the transport is connected (the socket is connected and the the HEL/ACK
                 * transaction has been done)
                 * @event connect
                 *
                 */
                self.emit("connect");
            } else {
                debugLog("_perform_HEL_ACK_transaction has failed with err=",err.message);
            }
            callback(err);
        });
    });

    if(self._isPassive){
        debugLog("emopen");
        setTimeout(function(){self._socket.emit("open")},500);
    }
};


ClientWSS_transport.prototype._handle_ACK_response = function (message_chunk, callback) {

    var self = this;
    var _stream = new BinaryStream(message_chunk);
    var messageHeader = readMessageHeader(_stream);
    var err;

    if (messageHeader.isFinal !== "F") {
        err = new Error(" invalid ACK message");
        callback(err);
        return;
    }

    var responseClass, response;

    if (messageHeader.msgType === "ERR") {
        responseClass = TCPErrorMessage;
        _stream.rewind();
        response = decodeMessage(_stream, responseClass);
        
        var err =new Error("ACK: ERR received " + response.statusCode.toString() + " : " + response.reason);
        err.statusCode =  response.statusCode;
        callback(err);

    } else {
        responseClass = AcknowledgeMessage;
        _stream.rewind();
        response = decodeMessage(_stream, responseClass);
        self.parameters = response;
        callback(null);
    }

};

ClientWSS_transport.prototype._send_HELLO_request = function () {

    var self = this;
    assert(self._socket);
    assert(_.isFinite(self.protocolVersion));
    assert(self.endpointUrl.length > 0, " expecting a valid endpoint url");

    // Write a message to the socket as soon as the client is connected,
    // the server will receive it as message from the client
    var request = new HelloMessage({
        protocolVersion: self.protocolVersion,
        receiveBufferSize:    1024 * 64 * 10,
        sendBufferSize:       1024 * 64 * 10,// 8196 min,
        maxMessageSize:       0, // 0 - no limits
        maxChunkCount:        0, // 0 - no limits
        endpointUrl: self.endpointUrl
    });

    var messageChunk = packTcpMessage("HEL", request);
    self._write_chunk(messageChunk);

};


ClientWSS_transport.prototype._perform_HEL_ACK_transaction = function (callback) {

    var self = this;
    assert(self._socket);
    assert(_.isFunction(callback));

    var counter = 0;
    debugLog("client wss transp HEL ACK trans");
    self._install_one_time_message_receiver(function on_ACK_response(err, data) {

        assert(counter === 0);
        counter += 1;

        if (err) {
            callback(err);
            self._socket.close();
        } else {
            self._handle_ACK_response(data, function (inner_err) {
                callback(inner_err);
            });
        }
    });
    self._send_HELLO_request();
};


exports.ClientWSS_transport = ClientWSS_transport;

