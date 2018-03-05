"use strict";

var factories = require("node-opcua-factory");

var ReverseHelloMessage_Schema = {
    name: "ReverseHelloMessage",
    id: factories.next_available_id(),
    fields: [
        {
            name: "serverUri",
            fieldType: "UAString",
            documentation: "The ApplicationUri of the Server which sent the message."
        },
        {
            name: "endpointUrl",
            fieldType: "UAString",
            documentation: "The URL of the Endpoint which the Client uses to establish the SecureChannel."
        }
    ]
};
exports.ReverseHelloMessage_Schema = ReverseHelloMessage_Schema;
