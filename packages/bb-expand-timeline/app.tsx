import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { mountTimelineDefaults } from "./summary-defaults";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "expand-timeline-rows",
    mount({ signal }) {
      return mountTimelineDefaults(signal);
    },
  });
});
