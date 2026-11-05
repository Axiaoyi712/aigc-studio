import {localMedia} from './media.mjs';
export function uploadFile(upload){if(upload?.file)return upload.file;const name=upload?.name||'',slash=name.lastIndexOf('/');return {type:'input',subfolder:slash<0?'':name.slice(0,slash),filename:name.slice(slash+1)};}
export function uploadPath(config,upload){return upload?localMedia(config,uploadFile(upload)):null;}
export function uploadName(upload){const f=uploadFile(upload);return [f.subfolder,f.filename].filter(Boolean).join('/')+(f.type==='input'?'':` [${f.type}]`);}
