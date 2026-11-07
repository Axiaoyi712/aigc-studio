import {createHash} from 'node:crypto';
function fail(message) { throw Object.assign(Error(message), {status:400}); }
export function validateCharacters(value, assets) {
  if (!Array.isArray(value) || value.length > 20) fail('角色档案最多 20 个。');
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object') fail('角色档案无效。');
    if (!/^[a-f0-9-]{36}$/.test(item.id) || ids.has(item.id)) fail('角色编号重复或无效。');
    ids.add(item.id);
    const name = String(item.name || '').trim();
    const description = String(item.description || '').trim();
    if (!name || name.length > 80 || description.length > 1600) fail('请填写角色名，固定外观描述不超过 1600 字。');
    if (!Array.isArray(item.referenceIds) || !item.referenceIds.length || item.referenceIds.length > 20 || new Set(item.referenceIds).size !== item.referenceIds.length || item.referenceIds.some(id => !assets.some(asset => asset.id === id && asset.category === 'character'))) fail('每个角色请选择 1～20 张角色类参考图；每镜全部参考合计不超过 20 张。');
    const result={id:item.id,name,description,referenceIds:[...item.referenceIds]};
    if(item.groupId)result.groupId=item.groupId;
    for(const key of ['identity','wardrobe'])if(item[key]!==undefined){result[key]=String(item[key]||'').trim();if(result[key].length>800)fail('身份或服装描述不超过 800 字。');}
    return result;
  });
}
export function characterContext(project, shot) {
  const characters = project.characters || [];
  const ids = shot.characterIds ?? characters.map(item => item.id);
  const roles = characters.filter(item => ids.includes(item.id));
  const referenceIds = [...new Set([...roles.flatMap(item => item.referenceIds), ...shot.referenceIds])];
  const signature = roles.length ? createHash('sha256').update(JSON.stringify(roles.map(({groupId,...role})=>role))).digest('hex') : null;
  const wardrobe=shot.director?.wardrobe;
  const backgroundPeople=/路人|人群|行人|群众|经过的人/.test([shot.director?.background,shot.videoPrompt].join(' '));
  const descriptions = roles.map(role => `角色「${role.name}」：${role.identity||role.description||'保持参考中的脸型、五官、发型和体型。'}${wardrobe||role.wardrobe?'；本镜头服装：'+(wardrobe||role.wardrobe):''}`).join('\n');
  const mappings = roles.map(role => `参考图 ${role.referenceIds.map(id => referenceIds.indexOf(id)+1).join('、')} 对应角色「${role.name}」。`).join('\n');
  return {roles,referenceIds,signature,imagePrefix: roles.length ? `固定角色参考：\n${mappings}\n${descriptions}\n保持各角色身份${wardrobe?'；服装采用本镜头指定款式':'与服装'}，角色之间不要混脸或互换外观。\n镜头画面：` : '',videoPrefix: roles.length ? `以已确认首帧中的人物为准，保持以下角色的五官、发型、服装、体型和配饰，${backgroundPeople?'配角按镜头正文安排':'不添加新人物'}，不互换身份。\n${descriptions}\n镜头动作：` : ''};
}
