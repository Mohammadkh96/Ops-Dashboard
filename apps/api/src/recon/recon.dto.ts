import {
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class ReplacePspsDto {
  @IsArray()
  psps!: unknown[];
}

export class SaveRunDto {
  @IsOptional()
  @IsString()
  ranBy?: string;

  @IsOptional()
  @IsInt()
  layer1Matched?: number;

  @IsOptional()
  @IsInt()
  layer1Total?: number;

  @IsOptional()
  @IsInt()
  layer2Matched?: number;

  @IsOptional()
  @IsInt()
  layer2Total?: number;

  @IsOptional()
  @IsInt()
  exceptionCount?: number;

  @IsOptional()
  @IsNumber()
  exposure?: number;

  @IsObject()
  summary!: object;
}
