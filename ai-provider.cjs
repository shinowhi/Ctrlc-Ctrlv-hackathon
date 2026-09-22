'use strict';
// Server configuration only. Neither a request body nor a document may choose a host.
function providerConfig(env=process.env) {
  const baseUrl=(env.OPENAI_BASE_URL||'https://api.openai.com/v1').trim().replace(/\/+$/,'');
  const providers={'https://api.openai.com/v1':'OpenAI','https://aishop.proxy-api.shop/v1':'AI Shop'};
  if(!Object.hasOwn(providers,baseUrl)) throw new Error('OPENAI_BASE_URL chỉ hỗ trợ OpenAI hoặc AI Shop.');
  const provider=providers[baseUrl];
  const model=(env.OPENAI_MODEL||'').trim()||(provider==='AI Shop'?'codex-auto-review':'gpt-4.1-mini');
  return {baseUrl,provider,model};
}
async function providerError(response,provider) {
  let code;try{code=(await response.json()).error?.code;}catch{}
  // Never forward provider messages, which can echo credentials or document data.
  if(response.status===401||code==='invalid_api_key')return `${provider}: khóa API không hợp lệ hoặc không thuộc dịch vụ đã chọn.`;
  if(['insufficient_quota','credit_balance_exhausted','project_spend_limit_exceeded','organization_spend_limit_exceeded','organization_usage_limit_exceeded'].includes(code))return `${provider}: hết credit hoặc đã chạm hạn mức chi tiêu. Kiểm tra số dư và Billing.`;
  if(response.status===429)return `${provider}: đang giới hạn tốc độ hoặc hạn mức. Chờ rồi thử lại và kiểm tra Limits.`;
  if([400,404,422].includes(response.status))return `${provider}: model chưa chấp nhận ảnh/PDF, Responses API hoặc JSON Schema. Kiểm tra OPENAI_MODEL.`;
  return `${provider}: dịch vụ chưa xử lý được minh chứng. Vui lòng thử lại sau.`;
}
module.exports={providerConfig,providerError};
