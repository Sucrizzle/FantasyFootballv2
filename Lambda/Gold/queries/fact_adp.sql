select
  adp.season
, adp.ADP
, adp.entity_id
from read_parquet('${bucket}/silver/adp/adp.parquet', union_by_name = true) adp