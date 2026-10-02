import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { mountSummaryDefaults } from "./summary-defaults";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "expand-activity-summaries",
    mount({ signal }) {
      return mountSummaryDefaults(signal);
    },
  });
});
