import type { ConfigPlugin } from 'expo/config-plugins';

type NitroPosePluginOptions = {
  /** Used unless the host declares ios.infoPlist.NSCameraUsageDescription. */
  cameraPermission?: string;
  /** Used unless the host declares ios.infoPlist.NSMotionUsageDescription. */
  motionPermission?: string;
};

declare const withNitroPose: ConfigPlugin<NitroPosePluginOptions | void>;
export = withNitroPose;
