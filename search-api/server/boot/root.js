// Copyright IBM Corp. 2016. All Rights Reserved.
// Node module: loopback-workspace
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

'use strict';

const utils = require("../../common/utils");

module.exports = function (server) {
  // Install a `/` route that returns server status
  const router = server.loopback.Router();
  router.get('/', (req, res) => {

    const api_version = process.env.API_VERSION || "unknown";
    const docker_image_version = process.env.DOCKER_IMAGE_VERSION || "unknown";
    const hosting_facility = process.env.HOSTING_FACILITY || "unknown";
    const environment = process.env.ENVIRONMENT || "unknown";
    const data_providers = process.env.PROVIDERS.split(',') || ["unknown"];
    const provider_timeout_ms = parseInt(process.env.PROVIDER_TIMEOUT || "1000");
    const default_limit = parseInt(process.env.DEFAULT_LIMIT || "100");
    const filter_invalid_scores = utils.getBoolEnvVar("FILTER_INVALID_SCORES", true);

    function format(seconds) {
      function pad(s) {
        return (s < 10 ? '0' : '') + s;
      }
      var hours = Math.floor(seconds / (60 * 60));
      var minutes = Math.floor(seconds % (60 * 60) / 60);
      var seconds = Math.floor(seconds % 60);

      return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
    }

    const uptime = process.uptime();

    const response_string = {
      'uptime_seconds': uptime,
      'uptime': format(uptime),
      'api_version': api_version,
      'docker_image_version': docker_image_version,
      'hosting_facility': hosting_facility,
      'environment': environment,
      'data_providers': data_providers,
      'provider_timeout_ms': provider_timeout_ms,
      'default_limit': default_limit,
      'filter_invalid_scores': filter_invalid_scores
    };

    res.send(response_string);
  });

  server.use(router);
};
