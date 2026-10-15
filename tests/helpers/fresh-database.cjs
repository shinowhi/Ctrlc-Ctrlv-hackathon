const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite');

const root=path.join(__dirname,'../..');
const migrationFiles=fs.readFileSync(path.join(root,'supabase/fresh-install-migrations.txt'),'utf8')
  .split(/\r?\n/)
  .map(line=>line.trim())
  .filter(line=>line&&!line.startsWith('#'));

async function createFreshDatabase(userIds=[]){
  const db=new PGlite();
  try{
    await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;"+
      "create table auth.users(id uuid primary key,is_anonymous boolean not null default false);"+
      "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;"+
      "create function auth.role() returns text language sql stable as $$select coalesce(current_setting('request.jwt.claim.role',true),'')$$;"+
      "create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;"+
      "create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);"+
      "create table storage.objects(id bigint generated always as identity,name text,bucket_id text);"+
      "alter table storage.objects enable row level security;"+
      "grant usage on schema public,auth,storage to authenticated,service_role;"+
      "grant select on storage.objects to authenticated;");
    if(userIds.length){
      const values=userIds.map((_,index)=>`($${index+1})`).join(',');
      await db.query(`insert into auth.users(id) values ${values}`,userIds);
    }
    await db.exec(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
    for(const filename of migrationFiles){
      if(!/^[a-z0-9-]+\.sql$/i.test(filename)) throw new Error(`Invalid fresh-install migration name: ${filename}`);
      await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',filename),'utf8'));
    }
    return db;
  }catch(error){
    await db.close();
    throw error;
  }
}

module.exports={createFreshDatabase,migrationFiles};
