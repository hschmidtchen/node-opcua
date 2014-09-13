Error.stackTraceLimit = Infinity;

var opcua = require("..");
var OPCUAServer = opcua.OPCUAServer;
var Variant = opcua.Variant;
var DataType = opcua.DataType;

var path = require("path");
var address_space_for_conformance_testing = require("../lib/simulation/address_space_for_conformance_testing");
var build_address_space_for_conformance_testing = address_space_for_conformance_testing.build_address_space_for_conformance_testing;


var default_xmlFile = __dirname + "/../nodesets/Opc.Ua.NodeSet2.xml";


console.log(" node set ", default_xmlFile);

var server = new OPCUAServer({ nodeset_filename: default_xmlFile});

var endpointUrl = server.endpoints[0].endpointDescriptions()[0].endpointUrl;
var hostname = require("os").hostname().toLowerCase();

var discovery_server_endpointUrl = "opc.tcp://" + hostname + ":4840/UADiscovery";
console.log(" endpointUrl = ", endpointUrl);

console.log(" registering server to " + discovery_server_endpointUrl);

server.registerServer(discovery_server_endpointUrl, function (err) {
    if (err) {
        //
        // cannot register server in discovery
        console.log(" warning : cannot register server into registry server");
    } else {
        console.log(" registering server: done.");
    }
});


/**
 * optionally install a CPU Usage and Memory Usage node
 * ( condition : running on linux and require("usage")
 */
function install_optional_cpu_and_memory_usage_node(server) {

    var usage;
    try {
        usage = require('usage');
    } catch(err) {
        console.log("skipping installation of cpu_usage and memory_usage nodes")
        return;
    }

    var folder = server.engine.findObjectByBrowseName("VendorServerInfo");

    var usage_result = { memory : 0 , cpu: 100};

    var pid = process.pid;
    var options = { keepHistory: true };

    setInterval(function() {
            usage.lookup(pid, options, function(err, result) {
            usage_result  = result;
            console.log("result", result);
        })
    },1000);

    server.engine.addVariableInFolder(folder, {
        browseName: "CPUUsage",
        description: "Current CPU usage of the server process",
        nodeId: "ns=2;s=CPUUsage",
        dataType: "Double",
        value: { get: function () {
            if (!usage_result) {
                return opcua.StatusCodes.BadResourceUnavailable;
            }
            return new Variant({dataType: DataType.Double, value: usage_result.cpu});
        } }
    });

    server.engine.addVariableInFolder(folder, {
        browseName: "MemoryUsage",
        nodeId: "ns=2;s=MemoryUsage",
        description: "Current CPU usage of the server process",
        dataType: "Number",
        value: { get: function () {
            if (!usage_result) {
                return opcua.StatusCodes.BadResourceUnavailable;
            }
            return new Variant({dataType: DataType.UInt32, value: usage_result.memory});
        } }
    });

}

server.on("post_initialize", function () {

    build_address_space_for_conformance_testing(server.engine);

    var myDevices = server.engine.createFolder("Objects", { browseName: "MyDevices"});

    server.engine.addVariableInFolder(myDevices,
        {
            browseName: "PumpSpeed",
            nodeId: "ns=2;s=PumpSpeed",
            dataType: "Double",
            value: {
                get: function () {
                    var pump_speed = 200 + 100*Math.sin(Date.now()/10000);
                    return new Variant({dataType: DataType.Double, value: pump_speed});
                },
                set: function (variant) {
                    return StatusCodes.BadNotWritable;
                }
            }
        });

    install_optional_cpu_and_memory_usage_node(server);

});

server.start(function () {
    console.log("  server on port".yellow, server.endpoints[0].port.toString().cyan);
    console.log("  server now waiting for connections. CTRL+C to stop".yellow);
    console.log("  endpointUrl = ".yellow, endpointUrl.cyan);
});


server.on("request", function (request) {
    console.log(request._schema.name);
    switch (request._schema.name) {
        case "ReadRequest":
            var str = "";
            request.nodesToRead.map(function (node) {
                str += node.nodeId.toString() + " " + node.attributeId + " ";
            });
            console.log(str);
            break;
        case "TranslateBrowsePathsToNodeIdsRequest":
            console.log(util.inspect(request, {colors: true, depth: 10}));
            break;
    }
    // console.log(util.inspect(request,{colors:true,depth:10}));
});
