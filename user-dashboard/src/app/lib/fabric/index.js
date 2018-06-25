'use strict';

const hfc = require('fabric-client');
const User = require('fabric-client/lib/User.js');
const copService = require('fabric-ca-client');
const fs = require('fs-extra');
const path = require('path');
const util = require('util');

module.exports = app => {
  function getKeyStoreForOrg(keyValueStore, org) {
    return keyValueStore + '/' + org;
  }
  function newOrderer(network, client) {
    const caRootsPath = network.orderer.tls_cacerts;
    const data = fs.readFileSync(caRootsPath);
    const caroots = Buffer.from(data).toString();
    return client.newOrderer(network.orderer.url, {
      pem: caroots,
      'ssl-target-name-override': network.orderer['server-hostname'],
    });
  }
  async function buildTarget(helper, peer, org) {
    let target = null;
    const { network } = helper;
    if (typeof peer !== 'undefined') {
      const targets = await newPeers(network, [peer], org, helper.clients);
      if (targets && targets.length > 0) target = targets[0];
    }

    return target;
  }
  function setupPeers(network, channel, org, client) {
    for (const key in network[org].peers) {
      const data = fs.readFileSync(network[org].peers[key].tls_cacerts);
      const peer = client.newPeer(
        network[org].peers[key].requests,
        {
          pem: Buffer.from(data).toString(),
          'ssl-target-name-override': network[org].peers[key]['server-hostname'],
        }
      );
      peer.setName(key);

      channel.addPeer(peer);
    }
  }
  async function newRemotes(network, names, forPeers, userOrg, clients) {
    const client = await getClientForOrg(userOrg, clients);

    const targets = [];
    // find the peer that match the names
    for (const idx in names) {
      const peerName = names[idx];
      app.logger.debug('peer Name ', peerName);
      if (network[userOrg].peers[peerName]) {
        // found a peer matching the name
        app.logger.debug(userOrg, peerName, network[userOrg].peers[peerName]);
        const data = fs.readFileSync(network[userOrg].peers[peerName].tls_cacerts);
        const grpcOpts = {
          pem: Buffer.from(data).toString(),
          'ssl-target-name-override': network[userOrg].peers[peerName]['server-hostname'],
        };

        if (forPeers) {
          targets.push(client.newPeer(network[userOrg].peers[peerName].requests, grpcOpts));
        } else {
          const eh = await client.newEventHub();
          eh.setPeerAddr(network[userOrg].peers[peerName].events, grpcOpts);
          targets.push(eh);
        }
      }
    }

    if (targets.length === 0) {
      app.logger.error('Failed to find peers matching the names %s', names);
    }

    return targets;
  }
  async function newPeers(network, names, org, clients) {
    return await newRemotes(network, names, true, org, clients);
  }

  async function newEventHubs(network, names, org, clients) {
    return await newRemotes(network, names, false, org, clients);
  }
  async function getClientForOrg(org, clients) {
    return clients[org];
  }
  async function getChannelForOrg(org, channels) {
    return channels[org];
  }
  function getOrgName(org, network) {
    return network[org].name;
  }
  function getMspID(org, network) {
    app.logger.debug('Msp ID : ' + network[org].mspid);
    return network[org].mspid;
  }
  function readAllFiles(dir) {
    const files = fs.readdirSync(dir);
    const certs = [];
    files.forEach(file_name => {
      const data = fs.readFileSync(path.join(dir, file_name));
      certs.push(data);
    });
    return certs;
  }
  async function getOrgAdmin(userOrg, helper) {
    const { network, clients, keyValueStore } = helper;
    const admin = network[userOrg].admin;
    const keyPEM = Buffer.from(readAllFiles(admin.key)[0]).toString();
    const certPEM = readAllFiles(admin.cert)[0].toString();

    const client = await getClientForOrg(userOrg, clients);
    const cryptoSuite = hfc.newCryptoSuite();
    if (userOrg) {
      cryptoSuite.setCryptoKeyStore(hfc.newCryptoKeyStore({ path: getKeyStoreForOrg(keyValueStore, getOrgName(userOrg, network)) }));
      client.setCryptoSuite(cryptoSuite);
    }

    const store = await hfc.newDefaultKeyValueStore({
      path: getKeyStoreForOrg(keyValueStore, getOrgName(userOrg, network)),
    });
    client.setStateStore(store);
    const user = client.createUser({
      username: 'peer' + userOrg + 'Admin',
      mspid: getMspID(userOrg, network),
      cryptoContent: {
        privateKeyPEM: keyPEM,
        signedCertPEM: certPEM,
      },
    });
    return user;
  }
  async function getAdminUser(helper, org) {
    const { keyValueStore, network } = helper;
    const users = [
      {
        username: 'admin',
        secret: 'adminpw',
      },
    ];
    const username = users[0].username;
    const password = users[0].secret;
    const client = await getClientForOrg(org, helper.clients);

    const store = await hfc.newDefaultKeyValueStore({
      path: getKeyStoreForOrg(keyValueStore, getOrgName(org, network)),
    });
    client.setStateStore(store);
    // clearing the user context before switching
    client._userContext = null;
    const user = await client.getUserContext(username, true);
    if (user && user.isEnrolled()) {
      app.logger.debug('Successfully loaded member from persistence');
      return user;
    }
    const caClient = helper.caClients[org];
    const enrollment = await caClient.enroll({
      enrollmentID: username,
      enrollmentSecret: password,
    });
    app.logger.info('Successfully enrolled user \'' + username + '\'');
    const member = new User(username);
    member.setCryptoSuite(client.getCryptoSuite());
    await member.setEnrollment(enrollment.key, enrollment.certificate, getMspID(org, network));
    await client.setUserContext(member);
    return member;

  }
  async function createChannel(network, keyValueStorePath, channelName, channelConfigPath) {
    const helper = await fabricHelper(network, keyValueStorePath);
    const client = await getClientForOrg('org1', helper.clients);
    const channel = await getChannelForOrg('org1', helper.channels);
    const envelope = fs.readFileSync(`${channelConfigPath}/${channelName}.tx`);
    const channelConfig = client.extractChannelConfig(envelope);
    await getOrgAdmin('org1', helper);
    const signature = client.signChannelConfig(channelConfig);

    const request = {
      config: channelConfig,
      signatures: [signature],
      name: channelName,
      orderer: channel.getOrderers()[0],
      txId: client.newTransactionID(),
    };
    try {
      const response = await client.createChannel(request);
      app.logger.debug('response ', response);
    } catch (e) {
      app.logger.error(e.message);
    }
  }
  async function joinChannelPromise(eventhubs, channelName, org, helper, request) {
    const eventPromises = [];
    const channel = await getChannelForOrg(org, helper.channels);
    eventhubs.forEach(eh => {
      const txPromise = new Promise((resolve, reject) => {
        const handle = setTimeout(reject, 30000);
        eh.registerBlockEvent(block => {
          clearTimeout(handle);
          // in real-world situations, a peer may have more than one channels so
          // we must check that this block came from the channel we asked the peer to join
          if (block.data.data.length === 1) {
            // Config block must only contain one transaction
            const channel_header = block.data.data[0].payload.header.channel_header;
            if (channel_header.channel_id === channelName) {
              resolve();
            } else {
              reject();
            }
          }
        });
      });
      eventPromises.push(txPromise);
    });
    const sendPromise = channel.joinChannel(request);
    return Promise.all([sendPromise].concat(eventPromises));
  }
  async function joinChannel(network, keyValueStorePath, channelName, peers, org) {
    const helper = await fabricHelper(network, keyValueStorePath);
    const client = await getClientForOrg('org1', helper.clients);
    const channel = await getChannelForOrg('org1', helper.channels);

    await getOrgAdmin('org1', helper);
    let txId = await client.newTransactionID();
    let request = {
      txId,
    };
    const allEventhubs = [];
    const closeConnections = async function(isSuccess) {
      if (isSuccess) {
        app.logger.debug('\n============ Join Channel is SUCCESS ============\n');
      } else {
        app.logger.debug('\n!!!!!!!! ERROR: Join Channel FAILED !!!!!!!!\n');
      }
      for (const key in allEventhubs) {
        const eventhub = allEventhubs[key];
        if (eventhub && eventhub.isconnected()) {
          await eventhub.disconnect();
        }
      }
    };

    const genesisBlock = await channel.getGenesisBlock(request);
    txId = await client.newTransactionID();
    request = {
      targets: await newPeers(network, peers, org, helper.clients),
      txId,
      block: genesisBlock,
    };

    const eventhubs = await newEventHubs(network, peers, org, helper.clients);
    for (const key in eventhubs) {
      const eh = eventhubs[key];
      eh.connect();
      allEventhubs.push(eh);
    }
    const results = await joinChannelPromise(eventhubs, channelName, org, helper, request);
    app.logger.debug('Join Channel R E S P O N S E : %j', results);
    if (results[0] && results[0][0] && results[0][0].response && results[0][0]
      .response.status === 200) {
      app.logger.info(
        'Successfully joined peers in organization %s to the channel \'%s\'',
        org, channelName);
      await closeConnections(true);
      return {
        success: true,
        message: util.format(
          'Successfully joined peers in organization %s to the channel \'%s\'',
          org, channelName),
      };
    }
    await closeConnections(false);
    return {
      success: false,
    };
  }
  async function installSmartContract(network, keyValueStorePath, peers, userId, smartContractCodeId, chainId, org) {
    const ctx = app.createAnonymousContext();
    const smartContractCode = await ctx.model.SmartContractCode.findOne({ _id: smartContractCodeId });
    const chain = await ctx.model.Chain.findOne({ _id: chainId });
    const chainCodeName = `${chain.chainId}-${smartContractCodeId}`;
    const smartContractSourcePath = `github.com/${smartContractCodeId}`;
    const chainRootPath = `/opt/data/${userId}/chains/${chainId}`;
    process.env.GOPATH = chainRootPath;
    fs.ensureDirSync(`${chainRootPath}/src/github.com`);
    fs.copySync(smartContractCode.path, `${chainRootPath}/src/${smartContractSourcePath}`);

    const helper = await fabricHelper(network, keyValueStorePath);
    const client = await getClientForOrg('org1', helper.clients);

    await getOrgAdmin('org1', helper);

    const request = {
      targets: await newPeers(network, peers, org, helper.clients),
      chaincodePath: smartContractSourcePath,
      chaincodeId: chainCodeName,
      chaincodeVersion: smartContractCode.version,
    };
    const results = await client.installChaincode(request);
    const proposalResponses = results[0];
    // const proposal = results[1];
    let all_good = true;
    for (const i in proposalResponses) {
      let one_good = false;
      if (proposalResponses && proposalResponses[i].response &&
        proposalResponses[i].response.status === 200) {
        one_good = true;
        ctx.logger.info('install proposal was good');
      } else {
        ctx.logger.error('install proposal was bad');
      }
      all_good = all_good & one_good;
    }
    if (all_good) {
      ctx.logger.info(util.format(
        'Successfully sent install Proposal and received ProposalResponse: Status - %s',
        proposalResponses[0].response.status));
      ctx.logger.debug('\nSuccessfully Installed chaincode on organization ' + org +
        '\n');
      const deploy = await ctx.model.SmartContractDeploy.findOneAndUpdate({
        smartContractCode,
        smartContract: smartContractCode.smartContract,
        name: chainCodeName,
        chain: chainId,
        user: userId,
      }, {
        status: 'installed',
      }, { upsert: true, new: true });
      return {
        success: true,
        deployId: deploy._id.toString(),
        message: 'Successfully Installed chaincode on organization ' + org,
      };
    }
    ctx.logger.error(
      'Failed to send install Proposal or receive valid response. Response null or status is not 200. exiting...'
    );
    return {
      success: false,
      message: 'Failed to send install Proposal or receive valid response. Response null or status is not 200. exiting...',
    };

  }
  async function instantiateSmartContract(network, keyValueStorePath, channelName, deployId, functionName, args, org) {
    const ctx = app.createAnonymousContext();
    const deploy = await ctx.model.SmartContractDeploy.findOne({ _id: deployId }).populate('smartContractCode');
    deploy.status = 'instantiating';
    deploy.save();
    const helper = await fabricHelper(network, keyValueStorePath);
    const client = await getClientForOrg('org1', helper.clients);
    const channel = await getChannelForOrg('org1', helper.channels);

    await getOrgAdmin('org1', helper);
    await channel.initialize();
    const txId = client.newTransactionID();
    // send proposal to endorser
    const request = {
      chaincodeId: deploy.name,
      chaincodeVersion: deploy.smartContractCode.version,
      args,
      txId,
    };

    if (functionName) { request.fcn = functionName; }

    const results = await channel.sendInstantiateProposal(request);

    const proposalResponses = results[0];
    const proposal = results[1];
    let all_good = true;
    for (const i in proposalResponses) {
      let one_good = false;
      if (proposalResponses && proposalResponses[i].response &&
        proposalResponses[i].response.status === 200) {
        one_good = true;
        ctx.logger.debug('instantiate proposal was good');
      } else {
        ctx.logger.error('instantiate proposal was bad');
      }
      all_good = all_good & one_good;
    }
    if (all_good) {
      deploy.status = 'instantiated';
      deploy.deployTime = Date.now();
      deploy.save();
      ctx.logger.info(util.format(
        'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s", metadata - "%s", endorsement signature: %s',
        proposalResponses[0].response.status, proposalResponses[0].response.message,
        proposalResponses[0].response.payload, proposalResponses[0].endorsement
          .signature));
      const promiseRequest = {
        proposalResponses,
        proposal,
      };
      // set the transaction listener and set a timeout of 30sec
      // if the transaction did not get committed within the timeout period,
      // fail the test
      const deployId = await txId.getTransactionID();

      const eh = await client.newEventHub();
      const data = fs.readFileSync(network[org].peers.peer1.tls_cacerts);
      await eh.setPeerAddr(network[org].peers.peer1.events, {
        pem: Buffer.from(data).toString(),
        'ssl-target-name-override': network[org].peers.peer1['server-hostname'],
      });
      await eh.connect();

      const txPromise = new Promise((resolve, reject) => {
        const handle = setTimeout(() => {
          eh.disconnect();
          reject();
        }, 30000);

        eh.registerTxEvent(deployId, (tx, code) => {
          ctx.logger.info(
            'The chaincode instantiate transaction has been committed on peer ' +
            eh._ep._endpoint.addr);
          clearTimeout(handle);
          eh.unregisterTxEvent(deployId);
          eh.disconnect();

          if (code !== 'VALID') {
            ctx.logger.error('The chaincode instantiate transaction was invalid, code = ' + code);
            reject();
          } else {
            ctx.logger.info('The chaincode instantiate transaction was valid.');
            resolve();
          }
        });
      });

      const sendPromise = await channel.sendTransaction(promiseRequest);
      const promiseResults = await Promise.all([sendPromise].concat([txPromise]));
      return promiseResults[0];
    }
    deploy.status = 'error';
    deploy.save();
    ctx.logger.error(
      'Failed to send instantiate Proposal or receive valid response. Response null or status is not 200. exiting...'
    );
    return 'Failed to send instantiate Proposal or receive valid response. Response null or status is not 200. exiting...';

  }
  async function getRegisteredUsers(helper, username, org) {
    // const helper = await fabricHelper(network, keyValueStorePath);
    const { keyValueStore, network } = helper;
    const client = await getClientForOrg(org, helper.clients);
    let member;
    let enrollmentSecret = null;

    const store = await hfc.newDefaultKeyValueStore({
      path: getKeyStoreForOrg(keyValueStore, getOrgName(org, network)),
    });
    client.setStateStore(store);
    client._userContext = null;
    const user = await client.getUserContext(username, true);
    if (user && user.isEnrolled()) {
      app.logger.debug('Successfully loaded member from persistence');
      return user;
    }
    const caClient = helper.caClients[org];
    member = await getAdminUser(helper, org);
    enrollmentSecret = await caClient.register({
      enrollmentID: username,
      affiliation: org + '.department1',
    }, member);
    app.logger.debug(username + ' registered successfully');
    const message = await caClient.enroll({
      enrollmentID: username,
      enrollmentSecret,
    });
    if (message && typeof message === 'string' && message.includes(
      'Error:')) {
      app.logger.error(username + ' enrollment failed');
      return message;
    }
    app.logger.debug(username + ' enrolled successfully');

    member = new User(username);
    member._enrollmentSecret = enrollmentSecret;
    await member.setEnrollment(message.key, message.certificate, getMspID(org, network));
    await client.setUserContext(member);
    return member;

  }
  async function invokeChainCode(network, keyValueStorePath, peerNames, channelName, chainCodeName, fcn, args, username, org) {
    const helper = await fabricHelper(network, keyValueStorePath);
    const client = await getClientForOrg(org, helper.clients);
    const channel = await getChannelForOrg(org, helper.channels);
    const targets = (peerNames) ? await newPeers(network, peerNames, org, helper.clients) : undefined;
    await getRegisteredUsers(helper, username, org);
    const txId = client.newTransactionID();
    app.logger.debug(util.format('Sending transaction "%j"', txId));
    // send proposal to endorser
    const request = {
      chaincodeId: chainCodeName,
      fcn,
      args,
      chainId: channelName,
      txId,
    };

    if (targets) { request.targets = targets; }
    const results = await channel.sendTransactionProposal(request);
    const proposalResponses = results[0];
    const proposal = results[1];
    let all_good = true;
    for (const i in proposalResponses) {
      let one_good = false;
      if (proposalResponses && proposalResponses[i].response &&
        proposalResponses[i].response.status === 200) {
        one_good = true;
        app.logger.debug('transaction proposal was good');
      } else {
        app.logger.error('transaction proposal was bad');
      }
      all_good = all_good & one_good;
    }
    if (all_good) {
      app.logger.debug(util.format(
        'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s", metadata - "%s", endorsement signature: %s',
        proposalResponses[0].response.status, proposalResponses[0].response.message,
        proposalResponses[0].response.payload, proposalResponses[0].endorsement
          .signature));
      const transactionRequest = {
        proposalResponses,
        proposal,
      };
      // set the transaction listener and set a timeout of 30sec
      // if the transaction did not get committed within the timeout period,
      // fail the test
      const transactionID = txId.getTransactionID();
      const eventPromises = [];

      if (!peerNames) {
        peerNames = channel.getPeers().map(function(peer) {
          return peer.getName();
        });
      }

      const eventhubs = await newEventHubs(network, peerNames, org, helper.clients);
      for (const key in eventhubs) {
        const eh = eventhubs[key];
        eh.connect();

        const txPromise = new Promise((resolve, reject) => {
          const handle = setTimeout(() => {
            eh.disconnect();
            reject();
          }, 30000);

          eh.registerTxEvent(transactionID, (tx, code) => {
            clearTimeout(handle);
            eh.unregisterTxEvent(transactionID);
            eh.disconnect();

            if (code !== 'VALID') {
              app.logger.error(
                'The balance transfer transaction was invalid, code = ' + code);
              reject();
            } else {
              app.logger.info(
                'The balance transfer transaction has been committed on peer ' +
                eh._ep._endpoint.addr);
              resolve();
            }
          });
        });
        eventPromises.push(txPromise);
      }
      const sendPromise = channel.sendTransaction(transactionRequest);
      try {
        const promiseResults = await Promise.all([sendPromise].concat(eventPromises));
        const response = promiseResults[0];
        if (response.status === 'SUCCESS') {
          app.logger.info('Successfully sent transaction to the orderer.');
          return {
            transactionID: txId.getTransactionID(),
            success: true,
          };
        }
        app.logger.error('Failed to order the transaction. Error code: ' + response.status);
        return {
          success: false,
          message: 'Failed to order the transaction. Error code: ' + response.status,
        };

      } catch (err) {
        app.logger.error(
          'Failed to send transaction and get notifications within the timeout period.'
        );
        return {
          success: false,
          message: 'Failed to send transaction and get notifications within the timeout period.',
        };
      }
    } else {
      app.logger.error(
        'Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...'
      );
      return {
        success: false,
        message: 'Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...',
      };
    }
  }
  async function queryChainCode(network, keyValueStorePath, peer, channelName, chainCodeName, fcn, args, username, org) {
    const helper = await fabricHelper(network, keyValueStorePath);
    const client = await getClientForOrg(org, helper.clients);
    const channel = await getChannelForOrg(org, helper.channels);
    const target = await buildTarget(helper, peer, org);
    await getRegisteredUsers(helper, username, org);
    const txId = client.newTransactionID();
    // send query
    const request = {
      chaincodeId: chainCodeName,
      txId,
      fcn,
      args,
    };
    try {
      const responsePayloads = await channel.queryByChaincode(request, target);
      if (responsePayloads) {
        for (let i = 0; i < responsePayloads.length; i++) {
          app.logger.debug('response payloads ', i, responsePayloads[i].toString('utf8'));
        }
        for (let i = 0; i < responsePayloads.length; i++) {
          return {
            success: true,
            result: responsePayloads[i].toString('utf8'),
          };
        }
      } else {
        app.logger.error('response_payloads is null');
        return {
          success: false,
          message: 'response_payloads is null',
        };
      }
    } catch (err) {
      return {
        success: false,
        message: 'Failed to send query due to error: ' + err.stack ? err.stack : err,
      };
    }
  }
  async function fabricHelper(network, keyValueStore) {
    const helper = {
      network,
      keyValueStore,
    };
    const clients = {};
    const channels = {};
    const caClients = {};
    for (const key in network) {
      if (key.indexOf('org') === 0) {
        const client = new hfc();
        const cryptoSuite = hfc.newCryptoSuite();
        cryptoSuite.setCryptoKeyStore(hfc.newCryptoKeyStore({ path: getKeyStoreForOrg(keyValueStore, network[key].name) }));
        client.setCryptoSuite(cryptoSuite);

        const channel = client.newChannel('mychannel');
        channel.addOrderer(newOrderer(network, client));

        clients[key] = client;
        channels[key] = channel;

        setupPeers(network, channel, key, client);

        const caUrl = network[key].ca;
        caClients[key] = new copService(caUrl, null, '', cryptoSuite);
      }
    }
    helper.clients = clients;
    helper.channels = channels;
    helper.caClients = caClients;
    return helper;
  }
  async function sleep(sleep_time_ms) {
    return new Promise(resolve => setTimeout(resolve, sleep_time_ms));
  }
  app.fabricHelper = fabricHelper;
  app.getClientForOrg = getClientForOrg;
  app.getOrgAdmin = getOrgAdmin;
  app.getChannelForOrg = getChannelForOrg;
  app.createChannel = createChannel;
  app.joinChannel = joinChannel;
  app.installSmartContract = installSmartContract;
  app.instantiateSmartContract = instantiateSmartContract;
  app.invokeChainCode = invokeChainCode;
  app.queryChainCode = queryChainCode;
  app.sleep = sleep;
  hfc.setLogger(app.logger);
};
