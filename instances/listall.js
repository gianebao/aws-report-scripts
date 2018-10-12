var AWS = require('aws-sdk');
var PROCESS = require('process');
var FS = require('fs');

var LogFile = "listall.log";

var msg = function(o) {
    o.date = new Date();
    FS.appendFileSync(LogFile, JSON.stringify(o)+"\n");
};

const rolesFilePath = PROCESS.cwd() + '/aws-roles.json';
var AWSRoles = [];
var AWSRegions = [];

// Get all Roles when aws-roles.json is available
if (FS.existsSync(rolesFilePath)) {
    msg({"type": "info","message": "aws-roles.json found"});
    AWSRoles = JSON.parse(FS.readFileSync(rolesFilePath, 'utf8'));    
}

// Setup credentials
var credentials = new AWS.SharedIniFileCredentials({profile: 'gianebao'});
AWS.config.credentials = credentials;
AWS.config.region = 'ap-southeast-1';

var EC2 = new AWS.EC2();
var Result = [];

var Output = function () {
    msg({"type":"info", "message": "generate output"})
    var csv = [
        ['account', 'region', 'type', 'instanceType', 'stateName', 'instanceId', 'keyName', 'tag']
    ];

    Result.forEach(function(r){
        var t = [];
        csv[0].forEach(function(i){
            t.push(r[i]);
        });
        csv.push(t);
    });

    csv.forEach(function(r){
        console.log('"' + r.join('","') + '"');
    });
};

var descEC2Instances = function(regions, done, params, additional){
    if (0 === regions.length) return done();

    var region = regions.shift();
    var _params = params;
    var _type = 'ec2';
    _params.region = region.RegionName;

    var EC2 = new AWS.EC2(_params);
    EC2.describeInstances(function(err, data){
        msg({"type": "info", "api": _type, "message": "listing all instances for region: " + region.RegionName});
        if (err) return console.log(err, err.stack);
        msg({"type": "info", "api": _type, "message": "found reservations: " + data.Reservations.length});
        data.Reservations.forEach(function (reservation) {
            msg({"type": "info", "api": _type, "message": "checking reservation: " +reservation.ReservationId+ ", found instances: " + reservation.Instances.length});
            reservation.Instances.forEach(function (r) {
                var tagName = '';
                r.Tags.forEach(function(t){
                    if ('Name' == t.Key) {
                        tagName = t.Value;
                        return false;
                    }
                });

                Result.push({
                    account: additional.role.arn,
                    'region': region.RegionName,
                    type: _type,
                    instanceType: r.InstanceType,
                    stateName: r.State.Name,
                    instanceId: r.InstanceId,
                    keyName: r.KeyName?r.KeyName:'',
                    tag: 'Name='+tagName
                });
            });
        });
        descEC2Instances(regions, done, params, additional);
    });
};

var descRDSInstances = function(regions, done, params, additional){
    if (0 === regions.length) return done();

    var region = regions.shift();
    var _params = params;
    var _type = 'rds';
    _params.region = region.RegionName;

    var RDS = new AWS.RDS(_params);
    RDS.describeDBInstances(function(err, data){
        msg({"type": "info", "api": _type, "message": "listing all instances for region: " + region.RegionName});
        if (err) return console.log(err, err.stack);
        msg({"type": "info", "api": _type, "message": "found: " + data.DBInstances.length});
        data.DBInstances.forEach(function (r) {
            Result.push({
                account: additional.role.arn,
                'region': region.RegionName,
                type: _type,
                instanceType: r.DBInstanceClass,
                stateName: r.DBInstanceStatus,
                instanceId: r.DbiResourceId,
                keyName: r.DBInstanceIdentifier,
                tag: 'Engine=' + r.Engine + ", AZ=" + (r.MultiAZ?'multi':'single')+", DBName=("+(r.DBName?r.DBName:'')+")"
            });
        });
        descRDSInstances(regions, done, params, additional);
    });
};

var descElastiCacheInstances = function(regions, done, params, additional){
    if (0 === regions.length) return done();

    var region = regions.shift();
    var _params = params;
    var _type = 'elasticache';
    _params.region = region.RegionName;

    var ElastiCache = new AWS.ElastiCache(_params);
    ElastiCache.describeCacheClusters(function(err, data){
        msg({"type": "info", "api": _type, "message": "listing all instances for region: " + region.RegionName});
        if (err) return console.log(err, err.stack);
        msg({"type": "info", "api": _type, "message": "found: " + data.CacheClusters.length});
        data.CacheClusters.forEach(function (r) {
            Result.push({
                account: additional.role.arn,
                'region': region.RegionName,
                type: _type,
                instanceType: r.CacheNodeType,
                stateName: r.CacheClusterStatus,
                instanceId: r.CacheClusterId,
                keyName: '',
                tag: 'Engine=' + r.Engine
            });
        });
        descElastiCacheInstances(regions, done, params, additional);
    });
};

var forEachRegion = function(regions, done, params, additional) {
    descEC2Instances(regions.slice(0), function () {
        descRDSInstances(regions.slice(0), function() {
            descElastiCacheInstances(regions.slice(0), done, params, additional);
        }, params, additional);
    }, params, additional);
};

var forEachRole = function (roles, done) {
    if (0 === roles.length) return done();
    var role = roles.shift(),
        roleName = '',
        roleAccount = '';
    
    for (roleName in role) roleAccount = role[roleName];
    msg({"type":"info", "message": "processing as role:" + roleName + " -> " + roleAccount, "role": role});

    var STS = new AWS.STS();
    STS.assumeRole({
        RoleArn: roleAccount,
        RoleSessionName: roleName
    }, function(err, data) {
        if (err) return console.log(err, err.stack);
        forEachRegion(AWSRegions.slice(0), function() {
            forEachRole(roles, done);
        }, {
            accessKeyId: data.Credentials.AccessKeyId,
            secretAccessKey: data.Credentials.SecretAccessKey,
            sessionToken: data.Credentials.SessionToken
        }, {role: {name: roleName, arn: roleAccount}});
    });
};

// List all regions
EC2.describeRegions({}, function(err, data){
    msg({"type": "info","message": "retrieving all regions available for ec2"});
    if (err) return console.log(err, err.stack);
    AWSRegions = data.Regions;

    // go through all regions in the root account
    msg({"type":"info", "message": "processing root account"})
    forEachRegion(AWSRegions.slice(0), function () {
        forEachRole(AWSRoles.slice(0), Output);
    }, {}, {role: {name: "root", arn: "root"}});
});

/*
handler = function () {
    var viewThisData = [];
    var response;
    var callBackCount=0;
    var instanceCount = 0;
    var runningInstances=0;
    var stoppedInstances=0;
    var nont2microInstances=0;
    response = {
        TotalInstanceCount: '',
        TotalRunningInstances: '',
        TotalNonT2MicroInstances: '',
        AllInstances: []
    };
    var regionNames = 
    
    regionNames.forEach(function(region) {
        getInstances(region);
    });
    function getInstances(region) {
        var regionName = region;
        var info = {
            region: ''
        };
        info.region = regionName;
        var EC2 = new AWS.EC2(info);
        var callbackData = {};
        var params = {};
        EC2.describeInstances(params, function(err, data) {
            var Ids = [];
            if (err) return console.log(err);
            data.Reservations.forEach(function(reservation) {
                var localData = {
                    InstanceId: '',
                    State: '',
                    InstanceType: '',
                    KeyName: ''
                };
                reservation.Instances.forEach(function(instance) {
                    if (instance.InstanceId[0] !== undefined) {
                        localData.InstanceId = (instance.InstanceId);
                        localData.KeyName = (instance.KeyName);
                        localData.InstanceType = (instance.InstanceType);
                        localData.State = (instance.State);
                        Ids.push(localData);
                        instanceCount++;
                        if(instance.State.Name==='running'){
                            runningInstances++;
                        }
                        else{
                            stoppedInstances++;
                        }
                        if(instance.InstanceType !== 't2.micro'){
                            nont2microInstances++;
                        }
                        else{
                            //
                        }
                    } else {
                        console.log("no inst");
                    }
                });
            });
            view(Ids, region);
        });
    }

    function view(Ids, region) {
        callBackCount++;
        if (Ids[0] === undefined) {
            //
        } else {
            var viewData = {
                region: "",
                Instances: []
            };
            viewData.region = region;
            viewData.Instances.push(Ids);
            viewThisData.push(viewData);
            response.TotalInstanceCount = instanceCount;
            response.TotalRunningInstances = runningInstances;
            response.TotalNonT2MicroInstances = nont2microInstances;
            response.AllInstances.push(viewData);
        }
        if (callBackCount == 10 && viewThisData[0] === undefined) {
            // console.log("ran-");
        } else if (callBackCount == 10 && viewThisData[0] !== undefined) {
            // console.log(JSON.stringify(response));
            var local = JSON.stringify(response, undefined, 3);
            callback(null, local);
        } else {
            //console.log("operation pending across few regions");
        }
    }
    //console.log(JSON.stringify(event));
};

handler(null, null, function(x, y){
    console.log("x:", x);
    console.log("y:", y);
});*/