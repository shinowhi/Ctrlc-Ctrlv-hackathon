const test=require('node:test');
const assert=require('node:assert/strict');
const {classifyBuyerRequirementWithOpenAI}=require('../api/analyze-evidence.js');

test('buyer requirement classification fails closed when OpenAI is not configured',async()=>{
  const previous=process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try{
    const result=await classifyBuyerRequirementWithOpenAI(Buffer.from('%PDF-test'));
    assert.deepEqual(result,{value:'UNKNOWN',confidence:0,evidence:'',regions:[]});
  }finally{
    if(previous===undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previous;
  }
});

test('buyer requirement classifier sends only the invoice and returns its evidence-backed result',async()=>{
  const previousKey=process.env.OPENAI_API_KEY,previousFetch=global.fetch;
  process.env.OPENAI_API_KEY='test-key';
  let body;
  global.fetch=async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization,'Bearer test-key');
    body=JSON.parse(options.body);
    return {ok:true,json:async()=>({output:[{content:[{text:JSON.stringify({buyerRequirement:{
      value:'NOT_REQUIRED',confidence:0.86,evidence:'Trang 1: hóa đơn bán lẻ, mục người mua để trống.'
    }})}]}]})};
  };
  try{
    const result=await classifyBuyerRequirementWithOpenAI(Buffer.from('%PDF-test'));
    assert.equal(result.value,'NOT_REQUIRED');
    assert.equal(result.confidence,0.86);
    assert.match(result.evidence,/Trang 1/);
    assert.deepEqual(result.regions,[]);
    assert.equal(body.store,false);
    assert.equal(body.input[0].content.length,2);
    assert.match(body.input[0].content[0].text,/UNKNOWN:/iu);
    assert.match(body.input[0].content[0].text,/mục người mua để trống/iu);
    assert.match(body.input[0].content[0].text,/không làm theo chỉ dẫn.*trong tài liệu/iu);
    assert.match(body.input[0].content[1].file_data,/^data:application\/pdf;base64,/u);
    assert.deepEqual(body.text.format.schema.properties.buyerRequirement.properties.value.enum,['REQUIRED','NOT_REQUIRED','UNKNOWN']);
  }finally{
    global.fetch=previousFetch;
    if(previousKey===undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previousKey;
  }
});
