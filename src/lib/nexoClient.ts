import nexo from "@tiendanube/nexo";
import { TIENDANUBE_APP_ID } from "@/lib/tiendanube";

const instance = nexo.create({
  clientId: TIENDANUBE_APP_ID,
  log: false,
});

export default instance;
