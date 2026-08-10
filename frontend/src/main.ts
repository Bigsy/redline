import { boot, renderFatal } from "./viewer";

boot().catch(renderFatal);
