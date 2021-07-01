import { Messages, SfdxError } from "@salesforce/core";
import SfpowerscriptsCommand from "../../../SfpowerscriptsCommand";
import { flags } from "@salesforce/command";
import PrepareImpl from "../../../impl/prepare/PrepareImpl";
import SFPStatsSender from "@dxatscale/sfpowerscripts.core/lib/stats/SFPStatsSender";
import { Stage } from "../../../impl/Stage";
import * as fs from "fs-extra";
import ScratchOrgInfoFetcher from "../../../impl/pool/services/fetchers/ScratchOrgInfoFetcher";
import Ajv from "ajv";
import path = require("path");
import { PoolErrorCodes } from "../../../impl/pool/PoolError";
import SFPLogger, { LoggerLevel } from "@dxatscale/sfpowerscripts.core/lib/logger/SFPLogger";

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages("@dxatscale/sfpowerscripts", "prepare");

export default class Prepare extends SfpowerscriptsCommand {
  protected static requiresDevhubUsername = true;
  protected static requiresProject = true;

  protected static flagsConfig = {
    poolconfig: flags.filepath({
      required: false,
      default: "config/cipoolconfig.json",
      char: "f",
      description: messages.getMessage("configDescription"),
    }),
    loglevel: flags.enum({
      description: "logging level for this command invocation",
      default: "info",
      required: false,
      options: [
        "trace",
        "debug",
        "info",
        "warn",
        "error",
        "fatal",
        "TRACE",
        "DEBUG",
        "INFO",
        "WARN",
        "ERROR",
        "FATAL",
      ],
    }),
  };

  public static description = messages.getMessage("commandDescription");

  public static examples = [
    `$ sfdx sfpowerscripts:orchestrator:prepare -t CI_1  -v <devhub>`,
  ];

  public async execute(): Promise<any> {
    let executionStartTime = Date.now();

    console.log("-----------sfpowerscripts orchestrator ------------------");
    console.log("command: prepare");

    //Read pool config
    try {
      let poolConfig = fs.readJSONSync(this.flags.poolconfig);
      this.validatePoolConfig(poolConfig);

      console.log(`Pool Name: ${poolConfig.tag}`);
      console.log(`Requested Count of Orgs: ${poolConfig.maxallocation}`);
      console.log(
        `Scratch Orgs to be submitted to pool in case of failures: ${
          poolConfig.succeedOnDeploymentErrors ? "true" : "false"
        }`
      );


      console.log(
        `All packages in the repo to be installed: ${poolConfig.installAll}`
      );
      if (poolConfig.fetchArtifacts) {
        console.log(
          `Script provided to fetch artifacts: ${
            poolConfig.fetchArtifacts.artifactfetchscript ? "true" : "false"
          }`
        );
        console.log(
          `Fetch artifacts from pre-authenticated NPM registry: ${
            poolConfig.fetchArtifacts.npm ? "true" : "false"
          }`
        );
        if (poolConfig.fetchArtifacts.npm?.npmtag)
          console.log(
            `Tag utilized to fetch from NPM registry: ${this.flags.npmtag}`
          );
      }

      console.log("---------------------------------------------------------");

      let tags = {
        stage: Stage.PREPARE,
        poolName: poolConfig.tag,
      };

      await this.hubOrg.refreshAuth();
      const hubConn = this.hubOrg.getConnection();

      this.flags.apiversion =
        this.flags.apiversion || (await hubConn.retrieveMaxApiVersion());

      let prepareImpl = new PrepareImpl(this.hubOrg, poolConfig);

      let results = await prepareImpl.exec();
      if (results.isOk()) {
        let totalElapsedTime = Date.now() - executionStartTime;
        SFPLogger.log(
          `-----------------------------------------------------------------------------------------------------------`
        );
        SFPLogger.log(
          `Provisioned {${
            results.value.scratchOrgs.length
          }}  scratchorgs out of ${results.value.to_allocate} requested with ${
            results.value.failedToCreate
          } failed in ${this.getFormattedTime(totalElapsedTime)} `,
          LoggerLevel.SUCCESS
        );
        SFPLogger.log(
          `----------------------------------------------------------------------------------------------------------`
        );

        await this.getCurrentRemainingNumberOfOrgsInPoolAndReport();

        SFPStatsSender.logGauge("prepare.succeededorgs", results.value.scratchOrgs.length, tags);

      } else if (results.isErr()) {

        console.log(
          `-----------------------------------------------------------------------------------------------------------`
        );
        SFPLogger.log(results.error.message,LoggerLevel.ERROR);
        console.log(
          `-----------------------------------------------------------------------------------------------------------`
        );

        switch (results.error.errorCode) {
          case PoolErrorCodes.Max_Capacity:
            process.exitCode = 0;
            break;
          case PoolErrorCodes.No_Capacity:
            process.exitCode = 0;
            break;
          case PoolErrorCodes.PrerequisiteMissing:
            process.exitCode = 1;
            break;
          case PoolErrorCodes.UnableToProvisionAny:
            SFPStatsSender.logGauge("prepare.failedorgs", results.error.failed, tags);
            process.exitCode=1;
            break;
        }
      }
      SFPStatsSender.logGauge(
        "prepare.duration",
        Date.now() - executionStartTime,
        tags
      );
    } catch (err) {
      throw new SfdxError("Unable to execute command .. " + err);
    }
  }

  private async getCurrentRemainingNumberOfOrgsInPoolAndReport() {
    try {
      const results = await new ScratchOrgInfoFetcher(
        this.hubOrg
      ).getScratchOrgsByTag(this.flags.tag, false, true);
      SFPStatsSender.logGauge("pool.remaining", results.records.length, {
        poolName: this.flags.tag,
      });
    } catch (error) {
      //do nothing, we are not reporting anything if anything goes wrong here
    }
  }

  private getFormattedTime(milliseconds: number): string {
    let date = new Date(0);
    date.setSeconds(milliseconds / 1000); // specify value for SECONDS here
    let timeString = date.toISOString().substr(11, 8);
    return timeString;
  }

  public validatePoolConfig(poolConfig: any) {
    console.log("...", __dirname);
    let resourcesDir = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "resources",
      "schemas"
    );
    let ajv = new Ajv({ allErrors: true });
    let schema = fs.readJSONSync(
      path.join(resourcesDir, `pooldefinition.schema.json`),
      { encoding: "UTF-8" }
    );
    let validator = ajv.compile(schema);
    let isSchemaValid = validator(poolConfig);
    if (!isSchemaValid) {
      let errorMsg: string = `The pool configuration is invalid, Please fix the following errors\n`;

      validator.errors.forEach((error, errorNum) => {
        errorMsg += `\n${errorNum + 1}: ${error.instancePath}: ${
          error.message
        } ${JSON.stringify(error.params, null, 4)}`;
      });

      throw new Error(errorMsg);
    }
  }
}
