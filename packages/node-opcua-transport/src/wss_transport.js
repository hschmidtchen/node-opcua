"use strict";
/**
 * @module opcua.transport
 */


// system requires
var EventEmitter = require("events").EventEmitter;
var assert = require("node-opcua-assert");
var _ = require("underscore");
var util = require("util");

// opcua requires
var PacketAssembler = require("node-opcua-packet-assembler").PacketAssembler;

var writeTCPMessageHeader = require("./tools").writeTCPMessageHeader;


var readRawMessageHeader =  require("./message_builder_base").readRawMessageHeader;


var buffer_utils = require("node-opcua-buffer-utils");
var createFastUninitializedBuffer = buffer_utils.createFastUninitializedBuffer;


var debug = require("node-opcua-debug");
var debugLog = debug.make_debugLog(__filename);
var doDebug = debug.checkDebugFlag(__filename);

var fakeSocket = {invalid: true};

exports.setFakeTransport = function (socket_like_mock) {
    fakeSocket = socket_like_mock;
};

exports.getFakeTransport = function () {
    if (fakeSocket.invalid){
        throw new Error("getFakeTransport: setFakeTransport must be called first  - BadProtocolVersionUnsupported");
    }
    return fakeSocket;
};

/**
 * WSS_transport
 *
 * @class WSS_transport
 * @constructor
 * @extends EventEmitter
 */
function WSS_transport() {

    /**
     * timeout
     * @property [timeout=30000]
     * @type {number}
     */
    this.timeout = 30000; // 30 seconds timeout

    this._socket = null;

    /**
     * @property headerSize the size of the header in bytes
     * @type {number}
     * @default  8
     */
    this.headerSize = 8;

    /**
     * @property protocolVersion indicates the version number of the OPCUA protocol used
     * @type {number}
     * @default  0
     */
    this.protocolVersion = 0;

    this.__disconnecting__ = false;

    this.bytesWritten = 0;
    this.bytesRead = 0;

    this._the_callback = null;


    /***
     * @property chunkWrittenCount
     * @type {number}
     */
    this.chunkWrittenCount= 0;
    /***
     * @property chunkReadCount
     * @type {number}
     */
    this.chunkReadCount= 0;
}


util.inherits(WSS_transport, EventEmitter);


/**
 * ```createChunk``` is used to construct a pre-allocated chunk to store up to ```length``` bytes of data.
 * The created chunk includes a prepended header for ```chunk_type``` of size ```self.headerSize```.
 *
 * @method createChunk
 * @param msg_type
 * @param chunk_type {String} chunk type. should be 'F' 'C' or 'A'
 * @param length
 * @return {Buffer} a buffer object with the required length representing the chunk.
 *
 * Note:
 *  - only one chunk can be created at a time.
 *  - a created chunk should be committed using the ```write``` method before an other one is created.
 */
WSS_transport.prototype.createChunk = function (msg_type, chunk_type, length) {

    assert(msg_type === "MSG");
    assert(this._pending_buffer === undefined, "createChunk has already been called ( use write first)");

    var total_length = length + this.headerSize;
    var buffer = createFastUninitializedBuffer(total_length);
    writeTCPMessageHeader("MSG", chunk_type, total_length, buffer);

    this._pending_buffer = buffer;

    return buffer;
};

var counter =0;
function record(data,extra) {

    extra = extra || "";

    var c = ("00000000" +counter.toString(10)).substr(-8);
    data._serialNumber = c;
    data.info = data.info || "";
    var l ="";// "-L="+("00000000" +data.length).substr(-8);
    require("fs").writeFileSync("data"+c+l+data.info+extra+".org",data,"binary");
    counter++;
}


WSS_transport.prototype._write_chunk = function (message_chunk) {
    var self = this;
    if (this._socket) {
        if(this._socket.readyState !== 1){
            if (doDebug) {
                debugLog(" SOCKET ERROR : ".red, "Socket not open!".yellow,this._socket.readyState, self._socket.name, self.name);
            }
        }else{
            this.bytesWritten += message_chunk.length;
            this.chunkWrittenCount ++;
            this._socket.send(message_chunk);
        }
    }
};

/**
 * write the message_chunk on the socket.
 * @method write
 * @param message_chunk {Buffer}
 *
 * Notes:
 *  - the message chunk must have been created by ```createChunk```.
 *  - once a message chunk has been written, it is possible to call ```createChunk``` again.
 *
 */
WSS_transport.prototype.write = function (message_chunk) {

    assert((this._pending_buffer === undefined) || this._pending_buffer === message_chunk, " write should be used with buffer created by createChunk");

    var header = readRawMessageHeader(message_chunk);
    assert(header.length === message_chunk.length);
    assert(["F", "C", "A"].indexOf(header.messageHeader.isFinal) !== -1);

    this._write_chunk(message_chunk);

    this._pending_buffer = undefined;
};


function _fulfill_pending_promises(err, data) {

    var self = this;

    _cleanup_timers.call(self);

    var the_callback = self._the_callback;
    self._the_callback = null;

    if (the_callback) {
        the_callback(err, data);
        return true;
    }
    return false;

}

function _on_message_received(message_chunk) {

    var self = this;
    var has_callback = _fulfill_pending_promises.call(self, null, message_chunk);
    self.chunkReadCount ++;

    if (!has_callback) {
        /**
         * notify the observers that a message chunk has been received
         * @event message
         * @param message_chunk {Buffer} the message chunk
         */
        self.emit("message", message_chunk);
    }
}


function _cleanup_timers() {

    var self = this;
    if (self._timerId) {
        clearTimeout(self._timerId);
        this._timerId = null;
    }
}

function _start_timeout_timer() {

    var self = this;
    assert(!self._timerId, "timer already started");
    self._timerId = setTimeout(function () {
        self._timerId =null;
        _fulfill_pending_promises.call(self, new Error("Timeout in waiting for data on socket ( timeout was = " + self.timeout + " ms )"));
    }, self.timeout);

}

WSS_transport.prototype.on_socket_closed = function(err) {

    var self = this;
    if (self._on_socket_closed_called) {
        return;
    }
    assert(!self._on_socket_closed_called);
    self._on_socket_closed_called = true; // we don't want to send close event twice ...
    /**
     * notify the observers that the transport layer has been disconnected.
     * @event socket_closed
     * @param err the Error object or null
     */
    self.emit("socket_closed", err || null);
};

WSS_transport.prototype.on_socket_ended = function(err) {
    var self = this;
    assert(!self._on_socket_ended_called);
    self._on_socket_ended_called = true; // we don't want to send close event twice ...
    /**
     * notify the observers that the transport layer has been disconnected.
     * @event close
     * @param err the Error object or null
     */
    self.emit("close", err || null);
};

WSS_transport.prototype._on_socket_ended_message =  function(err) {

    var self = this;
    if (self.__disconnecting__) {
        return;
    }
    self._on_socket_ended = null;
    self._on_data_received = null;

    debugLog("Transport Connection ended".red + " " + self.name);
    assert(!self.__disconnecting__);
    err = err || new Error("_socket has been disconnected by third party");

    self.on_socket_ended(err);

    self.__disconnecting__ = true;

    debugLog(" bytesRead    = ", self.bytesRead);
    debugLog(" bytesWritten = ", self.bytesWritten);
    _fulfill_pending_promises.call(self, new Error("Connection aborted - ended by server : " + (err ? err.message : "")));
};


/**
 * @method _install_socket
 * @param socket {Socket}
 * @protected
 */
WSS_transport.prototype._install_socket = function (socket) {

    assert(socket);
    var self = this;

    self.name = " Transport " + counter;
    counter += 1;

    self._socket = socket;

    // install packet assembler ...
    self.packetAssembler = new PacketAssembler({
        readMessageFunc: readRawMessageHeader,
        minimumSizeInBytes: self.headerSize
    });

    self.packetAssembler.on("message", function (message_chunk) {
        _on_message_received.call(self, message_chunk);
    });


    self._socket.on("message", function (data) {
        self.bytesRead += data.length;
        if (data.length > 0) {
            self.packetAssembler.feed(data);
        }

    }).on("close", function (code, reason) {
        // istanbul ignore next
        if (doDebug) {
            debugLog(" SOCKET CLOSE (inst sock): ".red, "had_error =".yellow,code.toString().cyan,reason.toString().cyan,self.name);
        }
        if (self._socket ) {
            debugLog("  remote address = ",self._socket.url); //undefined for WebSocket.Server websockets
        }
        /*
        if (had_error) {
            if (self._socket) {
                self._socket.terminate();
            }
        }
        var err = had_error ? new Error("ERROR IN SOCKET") : null;

        if (doDebug) {
            debugLog(" SOCKET END : ".red, err ? err.message.yellow : "null", self._socket.name, self.name);
        }*/
        self._on_socket_ended_message();
        self.on_socket_closed();

    }).on("error", function (err) {
        // istanbul ignore next
        if (doDebug) {
            debugLog(" SOCKET ERROR : ".red, err.message.yellow, self._socket.name, self.name);
        }
        // node The "close" event will be called directly following this event.
    });
};


/**
 * @method _install_one_time_message_receiver
 *
 * install a one time message receiver callback
 *
 * Rules:
 * * WSS_transport will not emit the ```message``` event, while the "one time message receiver" is in operation.
 * * the WSS_transport will wait for the next complete message chunk and call the provided callback func
 *   ```callback(null,messageChunk);```
 * * if a messageChunk is not received within ```WSS_transport.timeout``` or if the underlying socket reports an error,
 *    the callback function will be called with an Error.
 *
 * @param callback {Function} the callback function
 * @param callback.err {null|Error}
 * @param callback.messageChunk {Buffer|null}
 * @protected
 */
WSS_transport.prototype._install_one_time_message_receiver = function (callback) {

    var self = this;
    assert(!self._the_callback, "callback already set");
    assert(_.isFunction(callback));
    self._the_callback = callback;
    _start_timeout_timer.call(self);

};


/**
 * disconnect the WSS layer and close the underlying socket.
 * The ```"close"``` event will be emitted to the observers with err=null.
 *
 * @method disconnect
 * @async
 * @param callback
 */
WSS_transport.prototype.disconnect = function (callback) {

    assert(_.isFunction(callback), "expecting a callback function, but got " + callback);

    var self = this;
    if (self.__disconnecting__) {
        callback();
        return;
    }

    assert(!self.__disconnecting__, "WSS Transport has already been disconnected");
    self.__disconnecting__ = true;

    assert(!self._the_callback, "disconnect shall not be called while the 'one time message receiver' is in operation");
    _cleanup_timers.call(self);

    if (self._socket) {
        self._socket.close();
        self._socket.terminate();
        self._socket = null;
    }

    setImmediate(function () {
        self.on_socket_ended(null);
        callback();
    });

};

WSS_transport.prototype.isValid = function() {
    var self = this;
    return self._socket && !self._socket.destroyed && !self.__disconnecting__;
};
exports.WSS_transport = WSS_transport;
