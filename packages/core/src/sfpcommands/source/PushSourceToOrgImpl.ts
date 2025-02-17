import DeploymentExecutor, { DeploySourceResult } from './DeploymentExecutor';
import PushSourceImpl from '../../sfdxwrappers/PushSourceImpl';
import PushErrorDisplayer from '../../display/PushErrorDisplayer';
import { Logger } from '../../logger/SFPLogger';
import SourceToMDAPIConvertor from '../../package/packageFormatConvertors/SourceToMDAPIConvertor';
import PackageMetadataPrinter from '../../display/PackageMetadataPrinter';
import PackageManifest from '../../package/PackageManifest';

export default class PushSourceToOrgImpl implements DeploymentExecutor {
    constructor(
        private target_org: string,
        private project_directory: string,
        private source_directory: string,
        private logger: Logger
    ) {}

    async exec(): Promise<DeploySourceResult> {
        let sourceToMdapiConvertor = new SourceToMDAPIConvertor(
            this.project_directory,
            this.source_directory,
            this.logger
        );

        let mdapiDir = (await sourceToMdapiConvertor.convert()).packagePath;

        PackageMetadataPrinter.printMetadataToDeploy(
            (await PackageManifest.create(mdapiDir)).manifestJson,
            this.logger
        );

        try {
            await new PushSourceImpl(this.target_org, this.project_directory).exec(true);

            return {
                deploy_id: null,
                result: true,
                message: 'pushed successfully',
            };
        } catch (error) {
            PushErrorDisplayer.printMetadataFailedToPush(JSON.parse(error.message), this.logger);
            return {
                deploy_id: null,
                result: false,
                message: error.message,
            };
        }
    }
}
