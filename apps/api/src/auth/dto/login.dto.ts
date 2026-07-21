import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'mohammad@tradin.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'change-me' })
  @IsString()
  @MinLength(8)
  password!: string;
}
