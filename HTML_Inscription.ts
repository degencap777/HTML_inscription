import {
  script,
  Psbt,
  initEccLib,
  networks,
  Signer as BTCSigner,
  crypto,
  payments,
  opcodes,
} from "bitcoinjs-lib";
import { Taptree } from "bitcoinjs-lib/src/types";
import { ECPairFactory, ECPairAPI } from "ecpair";
import ecc from "@bitcoinerlab/secp256k1";
import axios, { AxiosResponse } from "axios";
import networkConfig from "config/network.config";
import { WIFWallet } from "utils/WIFWallet";
import { SeedWallet } from "utils/SeedWallet";

// const network = networks.testnet;
const network = networks.bitcoin;

initEccLib(ecc as any);
const ECPair: ECPairAPI = ECPairFactory(ecc);

export const contentBuffer = (content: string) => {
  return Buffer.from(content, "utf8");
};
// const seed: string = process.env.MNEMONIC as string;
// const networkType: string = networkConfig.networkType;
// const wallet = new SeedWallet({ networkType: networkType, seed: seed });

const privateKey: string = process.env.PRIVATE_KEY as string;
const networkType: string = networkConfig.networkType;
const wallet = new WIFWallet({
  networkType: networkType,
  privateKey: privateKey,
});

// input data
const receiveAddress: string =
  "tb1ppx220ln489s5wqu8mqgezm7twwpj0avcvle3vclpdkpqvdg3mwqsvydajn";
const inscriptionId: string =
  "0fbde4c394f144c44b1e59465f58766359d1b086415b2a02881cd1f1477ccc5fi0";

const memeType: string = "text/html;charset=utf-8";
const contentBufferData: Buffer = contentBuffer(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Build Your Own Recursive Ordinal</title>
  </head>
  <body style="margin: 0px">
    <div>
      <img style="width:100%;margin:0px" src="/content/${inscriptionId}" />
    </div>
  </body>
</html>`);

const splitBuffer = (buffer: Buffer, chunkSize: number) => {
  let chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    chunks.push(chunk);
  }
  return chunks;
};
const contentBufferArray: Array<Buffer> = splitBuffer(contentBufferData, 400);

export function createChildInscriptionTapScript(): Array<Buffer> {
  const keyPair = wallet.ecPair;
  let childOrdinalStacks: any = [
    toXOnly(keyPair.publicKey),
    opcodes.OP_CHECKSIG,
    opcodes.OP_FALSE,
    opcodes.OP_IF,
    Buffer.from("ord", "utf8"),
    1,
    1,
    Buffer.concat([Buffer.from(memeType, "utf8")]),
    opcodes.OP_0,
  ];
  contentBufferArray.forEach((item: Buffer) => {
    childOrdinalStacks.push(item);
  });
  childOrdinalStacks.push(opcodes.OP_ENDIF);

  return childOrdinalStacks;
}

async function childInscribe() {
  const keyPair = wallet.ecPair;
  const childOrdinalStack = createChildInscriptionTapScript();

  const ordinal_script = script.compile(childOrdinalStack);

  const scriptTree: Taptree = {
    output: ordinal_script,
  };

  const redeem = {
    output: ordinal_script,
    redeemVersion: 192,
  };

  const ordinal_p2tr = payments.p2tr({
    internalPubkey: toXOnly(keyPair.publicKey),
    network,
    scriptTree,
    redeem,
  });

  const address = ordinal_p2tr.address ?? "";
  console.log("send coin to address", address);

  const utxos = await waitUntilUTXO(address as string);

  const psbt = new Psbt({ network });

  psbt.addInput({
    hash: utxos[0].txid,
    index: utxos[0].vout,
    tapInternalKey: toXOnly(keyPair.publicKey),
    witnessUtxo: { value: utxos[0].value, script: ordinal_p2tr.output! },
    tapLeafScript: [
      {
        leafVersion: redeem.redeemVersion,
        script: redeem.output,
        controlBlock: ordinal_p2tr.witness![ordinal_p2tr.witness!.length - 1],
      },
    ],
  });

  psbt.addOutput({
    address: receiveAddress, //Destination Address
    value: 546,
  });

  await signAndSend(keyPair, psbt);
}

childInscribe();

export async function signAndSend(keypair: BTCSigner, psbt: Psbt) {
  const signer = tweakSigner(keypair, { network });
  psbt.signInput(0, signer);
  psbt.signInput(1, keypair);
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();

  console.log(tx.virtualSize());
  console.log(tx.toHex());

  const txid = await broadcast(tx.toHex());
  console.log(`Success! Txid is ${txid}`);
}

export async function waitUntilUTXO(address: string) {
  return new Promise<IUTXO[]>((resolve, reject) => {
    let intervalId: any;
    const checkForUtxo = async () => {
      try {
        const response: AxiosResponse<string> = await blockstream.get(
          `/address/${address}/utxo`
        );
        const data: IUTXO[] = response.data
          ? JSON.parse(response.data)
          : undefined;
        console.log(data);
        if (data.length > 0) {
          resolve(data);
          clearInterval(intervalId);
        }
      } catch (error) {
        reject(error);
        clearInterval(intervalId);
      }
    };
    intervalId = setInterval(checkForUtxo, 4000);
  });
}

export async function getTx(id: string): Promise<string> {
  const response: AxiosResponse<string> = await blockstream.get(
    `/tx/${id}/hex`
  );
  return response.data;
}

const blockstream = new axios.Axios({
  // baseURL: `https://mempool.space/testnet/api`,
  baseURL: `https://mempool.space/api`,
});

export async function broadcast(txHex: string) {
  const response: AxiosResponse<string> = await blockstream.post("/tx", txHex);
  return response.data;
}

function tapTweakHash(pubKey: Buffer, h: Buffer | undefined): Buffer {
  return crypto.taggedHash(
    "TapTweak",
    Buffer.concat(h ? [pubKey, h] : [pubKey])
  );
}

function toXOnly(pubkey: Buffer): Buffer {
  return pubkey.subarray(1, 33);
}

function tweakSigner(signer: any, opts: any = {}) {
  let privateKey = signer.privateKey;
  if (!privateKey) {
    throw new Error("Private key is required for tweaking signer!");
  }
  if (signer.publicKey[0] === 3) {
    privateKey = ecc.privateNegate(privateKey);
  }
  const tweakedPrivateKey = ecc.privateAdd(
    privateKey,
    tapTweakHash(toXOnly(signer.publicKey), opts.tweakHash)
  );
  if (!tweakedPrivateKey) {
    throw new Error("Invalid tweaked private key!");
  }
  return ECPair.fromPrivateKey(Buffer.from(tweakedPrivateKey), {
    network: opts.network,
  });
}

interface IUTXO {
  txid: string;
  vout: number;
  status: {
    confirmed: boolean;
    block_height: number;
    block_hash: string;
    block_time: number;
  };
  value: number;
}
