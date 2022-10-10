'use strict';

/**
 * Dependencies.
 */

const assert = require('assert');
const remoting = require('strong-remoting');
const utils = require('loopback-datasource-juggler/lib/utils');
const jutil = require('loopback-datasource-juggler/lib/jutil');
const RelationMixin = require('./relations');
const InclusionMixin = require('loopback-datasource-juggler/lib/include');
const Aggregator = require('../aggregator');

const findMethodNames = ['findById', 'findOne'];

const limitMethodsString = ['Dataset.find', 'Document.find', 'Instrument.find'];

module.exports = DistributedConnector;

/**
 * Create an instance of the connector with the given `settings`.
 */

function DistributedConnector(settings) {
  assert(typeof settings ===
    'object',
    'cannot initialize DistributedConnector without a settings object');
  this.client = settings.client;
  this.adapter = settings.adapter || 'rest';
  this.protocol = settings.protocol || 'http';
  this.root = settings.root || '';
  this.host = settings.host || 'localhost';
  this.port = settings.port || 3000;
  this.name = 'distributed-connector';
  this.remotes = new Array();

  if (settings.urls) {
    console.log('Providers: ' + settings.urls);
    this.urls = settings.urls;
  } else {
    this.urls = [this.protocol + '://' + this.host + ':' + this.port + this.root];
  }
  for (let url of this.urls) {
    console.log('- url : ' + url);
    this.remotes.push({ 'url': url, 'timeout': settings.timeout, 'remote': remoting.create(settings.options) });
  }

  // handle mixins in the define() method
  const DAO = this.DataAccessObject = function () {
  };
}

DistributedConnector.prototype.connect = function () {
  for (let remoteData of this.remotes) {
    remoteData['remote'].connect(remoteData['url'], this.adapter);
  }
};

DistributedConnector.initialize = function (dataSource, callback) {
  const connector = dataSource.connector =
    new DistributedConnector(dataSource.settings);
  connector.connect();
  process.nextTick(callback);
};

DistributedConnector.prototype.define = function (definition) {
  //console.log("DistributedConnector.define");
  const Model = definition.model;
  const remotes = this.remotes;

  assert(Model.sharedClass,
    'cannot attach ' +
    Model.modelName +
    ' to a remote connector without a Model.sharedClass');

  jutil.mixin(Model, RelationMixin);
  jutil.mixin(Model, InclusionMixin);
  for (let remoteData of remotes) {
    remoteData['remote'].addClass(Model.sharedClass);
  }
  this.resolve(Model);
  this.setupRemotingTypeFor(Model);
};

DistributedConnector.prototype.resolve = function (Model) {
  //console.log('--------------------');
  //console.log("DistributedConnector.resolve");
  //console.log(" - Model : " + Model.modelName);
  const remotes = this.remotes;
  //console.log(" - Remotes : " + remotes.length);

  Model.sharedClass.methods().forEach(function (remoteMethod) {
    if (remoteMethod.name !== 'Change' && remoteMethod.name !== 'Checkpoint') {
      createProxyMethod(Model, remotes, remoteMethod);
    }
  });
};

DistributedConnector.prototype.setupRemotingTypeFor = function (Model) {
  const remotes = this.remotes;

  // setup a remoting type converter for this model
  for (let remoteData of remotes) {
    remoteData['remote'].defineObjectType(Model.modelName, function (data) {
      const model = new Model(data);

      // process cached relations
      if (model.__cachedRelations) {
        for (const relation in model.__cachedRelations) {
          const relatedModel = model.__cachedRelations[relation];
          model.__data[relation] = relatedModel;
        }
      }

      return model;
    });
  }
};

function createProxyMethod(Model, remotes, remoteMethod) {
  const scope = remoteMethod.isStatic ? Model : Model.prototype;
  const original = scope[remoteMethod.name];
  //console.log('--------------------');
  //console.log('distributedConnector:createProxyMethod');
  //console.log('- Model : ' + Model.modelName);
  //console.log('- Remotes : ' + remotes.length);
  //console.log('- Remotes Url : ' + remotes[0].url);
  //console.log('- remote Method :' + remoteMethod.name);

  function remoteMethodProxy() {
    //console.log('remoteMethodProxy:Arguments : ', JSON.stringify(arguments));
    const args = Array.prototype.slice.call(arguments);
    const lastArgIsFunc = typeof args[args.length - 1] === 'function';
    let callback;
    if (lastArgIsFunc) {
      callback = args.pop();
    } else {
      callback = utils.createPromiseCallback();
    }
    const callbackPromise = callback.promise;

    // check if the first element is a number
    // some document's id are just numbers and needs to be covnerted to string
    args[0] = (typeof args[0] == "number" ? args[0].toString() : args[0])

    // check if filter contains limit
    //console.log('remoteMethodProxy:args : ' + JSON.stringify(args));
    let limit = parseInt(process.env.DEFAULT_LIMIT || "100");;
    args.map(i => {
      if (typeof i != "string" && typeof i != "undefined" && 'limit' in i) {
        limit = i.limit;
      }
    });
    console.log('remoteMethodProxy:limit : ' + limit);

    // check if we have query and there for we need to use score to order results
    let sortByScore = args.some(i => {
      if (typeof i != "string" && typeof i != "undefined" && 'query' in i) {
        return true;
      }
    });
    console.log('remoteMethodProxy:order by score : ' + sortByScore);


    if (findMethodNames.includes(remoteMethod.name)) {
      callback = proxy404toNull(callback);
    }
    let data = new Array();
    if (remoteMethod.isStatic) {
      data = remotes.map(async remote => {
        //console.log('remoteMethodProxy:remote static :' + remote.url);
        //let remoteArgs = [...args];
        let remoteArgs = Array.prototype.slice.call(arguments);
        const lastArgIsFunc = typeof remoteArgs[remoteArgs.length - 1] === 'function';
        if (lastArgIsFunc) {
          remoteArgs.pop();
        }
        if (limitMethodsString.includes(remoteMethod.stringName)) {
          remoteArgs = remoteArgs.map(i => {
            if (typeof i != "string" && typeof i != "undefined") {
              //i.limit = Math.ceil(limit / remotes.length);
              i.limit = limit;
            } else if (typeof i == "undefined") {
              //i = {limit: Math.ceil(limit / remotes.length)};
              i = { limit: limit };
            }
            return i;
          });
        }
        remoteArgs = remoteArgs.map(r => { return (typeof r == 'string') ? encodeURIComponent(r) : r });
        console.log('remoteMethodProxy:remoteArgs : ' + JSON.stringify(remoteArgs));
        //console.log('remoteMethodProxy:method : ' + remoteMethod.stringName);
        //console.log('remoteMethodProxy:remoteArgs : ' + remoteArgs);
        //console.log('remoteMethodProxy:remoteUrl : ' + remote.url);
        //console.log('remoteMethodProxy:object : ' + remote.remote.objectName);
        console.log('remoteMethodProxy:method : ' + remoteMethod.stringName);
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            resolve([]);
            clearTimeout(timeoutId);
          }, remote['timeout']);
          remote['remote'].invoke(remoteMethod.stringName, remoteArgs, function (err, result) {
            console.log('Remote invoke : ' + remote.url);
            if (err != null) {
              console.log('Error');
              console.log('Remote method : ' + remoteMethod.stringName);
              if (!limitMethodsString.includes(remoteMethod.stringName) && err.statusCode == 404) {
                console.log('This backend does not have the requested item')
                resolve([]);
              } else {
                console.log(err);
                reject(err);
              }
            } else {
              if (Symbol.iterator in Object(result)) {
                for (let item of result) {
                  item.provider = remote.url;
                }
              }
              resolve(result);
            }
            // clear the timeout that we setup for this request
            clearTimeout(timeoutId);
          });
        });
      });
    } else {
      data = remotes.map(async remote => {
        const ctorArgs = [encodeURIComponent(this.id)];
        let remoteArgs = Array.prototype.slice.call(arguments);
        const lastArgIsFunc = typeof remoteArgs[remoteArgs.length - 1] === 'function';
        if (lastArgIsFunc) {
          remoteArgs.pop();
        }
        if (limitMethodsString.includes(remoteMethod.stringName)) {
          remoteArgs = remoteArgs.map(i => {
            if (typeof i != "undefined" && 'limit' in i) {
              //i.limit = Math.ceil(limit / remotes.length);
              i.limit = limit;
            } else if (typeof i == "undefined") {
              //i = {limit: Math.ceil(limit / remotes.length)};
              i = { limit: limit };
            }
            return i;
          });
        }
        return new Promise((resolve, reject) => {
          remote['remote'].invoke(remoteMethod.stringName, ctorArgs, remoteArgs, function (err, result) {
            console.log('Remote invoke : ' + remote.url);
            if (err != null) {
              console.log('Error');
              console.log(err);
              reject(err);
            } else if (Symbol.iterator in Object(result)) {
              for (let item of result) {
                item.provider = remote.url;
              }
            }
            resolve(result);
          });
        });
      });
    }
    // we aggregate all the results returned by all the facilities
    Promise.allSettled(data).then(function (results) {
      console.log('remoteMethodProxy:results : ' + JSON.stringify(results.length));
      Aggregator(
        results.map(e => e['value']),
        remoteMethod.name,
        callback,
        limit,
        sortByScore
      );
    });
    //.catch(error => {
    // console.log('Error');
    //});

    return callbackPromise;
  }

  function proxy404toNull(cb) {
    return function (err, data) {
      if (err && err.code === 'MODEL_NOT_FOUND') {
        cb(null, null);
        return;
      }
      cb(err, data);
    };
  }

  scope[remoteMethod.name] = remoteMethodProxy;
  remoteMethod.aliases.forEach(function (alias) {
    scope[alias] = remoteMethodProxy;
  });
}

function noop() {
}
