// @title Pocket Atlas
// One screen with a pad: the PSP and the Vita. pocket.json compiles this
// entry wherever no other presentation matches the device's modality.
import { mount } from "@pocketjs/framework";
import SingleScreen from "./presentations/single.tsx";

mount(() => <SingleScreen />);
